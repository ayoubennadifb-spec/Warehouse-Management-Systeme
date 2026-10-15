"""Software contract tests. No peripheral, network or database is accessed."""
from copy import deepcopy
from datetime import datetime, timezone
import unittest

from backend.hardware import HardwareError, HardwareGuard, MockAdapter, SWITCHES, self_test


class Clock:
    def __init__(self):
        self.now = 1_800_000_000.0

    def __call__(self):
        return self.now


class HardwareTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.adapter = MockAdapter(clock=self.clock, wall_clock=self.clock)
        self.guard = self.adapter.guard
        self.adapter.emit()
        self.guard.resume(operator_confirmed=True)

    def test_default_hardware_is_locked(self):
        status = HardwareGuard().status()
        self.assertFalse(status["physical_commands_enabled"])
        self.assertFalse(status["ready_for_mock_commands"])
        self.assertIn("calibration_missing", status["active_faults"])
        self.assertIn("telemetry_missing", status["active_faults"])

    def test_real_transport_cannot_be_enabled(self):
        guard = HardwareGuard(limits_mm=self.guard.limits_mm, calibration_id=self.guard.calibration_id,
                              source=self.guard.source, session_id=self.guard.session_id,
                              clock=self.clock, wall_clock=self.clock)
        guard.ingest_telemetry(self.adapter.sample())
        with self.assertRaises(HardwareError):
            guard.resume(operator_confirmed=True)
        with self.assertRaises(HardwareError):
            guard.prepare_move("real-attempt", {"x": 200, "y": 200, "z": 200})
        self.assertFalse(guard.status()["physical_commands_enabled"])

    def test_initial_start_and_resume_are_explicit(self):
        adapter = MockAdapter(clock=self.clock, wall_clock=self.clock)
        self.assertFalse(adapter.emit()["ready_for_mock_commands"])
        with self.assertRaises(HardwareError):
            adapter.guard.resume()
        with self.assertRaises(HardwareError):
            adapter.guard.resume(operator_confirmed=1)
        self.assertTrue(adapter.guard.resume(operator_confirmed=True)["ready_for_mock_commands"])

    def assert_fault_latched(self, bad, good, fault):
        status = self.adapter.emit(**bad)
        self.assertIn(fault, status["active_faults"])
        with self.assertRaises(HardwareError):
            self.guard.resume(operator_confirmed=True)
        self.assertFalse(self.adapter.emit(**good)["ready_for_mock_commands"])
        self.assertIn(fault, self.guard.status()["latched_faults"])
        self.assertTrue(self.guard.resume(operator_confirmed=True)["ready_for_mock_commands"])

    def test_estop_latches_until_explicit_resume(self):
        self.assert_fault_latched({"emergency_stop": True}, {"emergency_stop": False}, "emergency_stop")

    def test_disconnect_latches_until_explicit_resume(self):
        self.assert_fault_latched({"connected": False}, {"connected": True}, "disconnected")

    def test_all_limit_switches_block(self):
        for key in SWITCHES:
            with self.subTest(switch=key):
                self.assert_fault_latched(
                    {"limit_switches": {name: name == key for name in SWITCHES}},
                    {"limit_switches": {name: False for name in SWITCHES}}, "limit_switch_active")

    def test_homing_obstacle_and_unknown_gripper_block(self):
        self.assert_fault_latched({"homed": {"x": True, "y": False, "z": True}},
                                  {"homed": {"x": True, "y": True, "z": True}}, "homing_required")
        self.assert_fault_latched({"obstacle_clear": False}, {"obstacle_clear": True}, "obstacle_detected")
        self.assert_fault_latched({"gripper": "unknown"}, {"gripper": "empty"}, "gripper_unconfirmed")

    def test_measured_position_outside_limits_blocks(self):
        self.assert_fault_latched({"position_mm": {"x": -1, "y": 100, "z": 100}},
                                  {"position_mm": {"x": 100, "y": 100, "z": 100}}, "position_out_of_bounds")

    def test_timeout_detected_by_command(self):
        self.clock.now += 2
        with self.assertRaises(HardwareError):
            self.guard.prepare_move("late", {"x": 100, "y": 100, "z": 100})
        self.assertIn("telemetry_stale", self.guard.status()["active_faults"])
        self.assertFalse(self.adapter.emit()["ready_for_mock_commands"])
        self.assertTrue(self.guard.resume(operator_confirmed=True)["ready_for_mock_commands"])

    def test_late_packet_cannot_hide_connection_gap(self):
        self.clock.now += 2
        self.assertFalse(self.adapter.emit()["ready_for_mock_commands"])
        self.assertIn("telemetry_stale", self.guard.status()["latched_faults"])

    def test_unsafe_sample_cancels_pending_command(self):
        command = self.guard.prepare_move("cancelled", {"x": 200, "y": 200, "z": 200})
        self.adapter.emit(connected=False)
        self.adapter.emit(connected=True)
        self.guard.resume(operator_confirmed=True)
        self.assertIsNone(self.guard.status()["pending_command"])
        with self.assertRaises(HardwareError):
            self.guard.confirm(self.adapter.confirmation(command))
        with self.assertRaises(HardwareError):
            self.guard.prepare_move("cancelled", {"x": 200, "y": 200, "z": 200})

    def test_software_stop_latches(self):
        self.assertFalse(self.guard.emergency_stop()["ready_for_mock_commands"])
        self.adapter.emit()
        self.assertFalse(self.guard.status()["ready_for_mock_commands"])
        self.assertTrue(self.guard.resume(operator_confirmed=True)["ready_for_mock_commands"])

    def test_replayed_telemetry_needs_new_sample_then_resume(self):
        payload = self.adapter.sample()
        self.guard.ingest_telemetry(payload)
        with self.assertRaises(HardwareError):
            self.guard.ingest_telemetry(payload)
        with self.assertRaises(HardwareError):
            self.guard.resume(operator_confirmed=True)
        self.adapter.emit()
        self.assertFalse(self.guard.status()["ready_for_mock_commands"])
        self.assertTrue(self.guard.resume(operator_confirmed=True)["ready_for_mock_commands"])

    def test_bad_contract_samples_latch(self):
        mutations = [
            {"source": "foreign"}, {"session_id": "other-boot"}, {"version": True},
            {"sequence": True}, {"position_mm": {"x": float("nan"), "y": 0, "z": 0}},
            {"position_mm": {"x": True, "y": 0, "z": 0}},
            {"homed": {"x": True}}, {"limit_switches": {}}, {"emergency_stop": "false"},
            {"measured_at": "2026-01-01T00:00:00"}, {"calibration_id": ""},
        ]
        for change in mutations:
            with self.subTest(change=change):
                adapter = MockAdapter(clock=self.clock, wall_clock=self.clock)
                payload = adapter.sample()
                payload.update(change)
                with self.assertRaises(HardwareError):
                    adapter.guard.ingest_telemetry(payload)
                self.assertIn("invalid_telemetry", adapter.guard.status()["latched_faults"])

    def test_missing_or_extra_fields_rejected(self):
        payload = self.adapter.sample()
        del payload["obstacle_clear"]
        with self.assertRaises(HardwareError):
            self.guard.ingest_telemetry(payload)
        payload = self.adapter.sample()
        payload["unexpected"] = True
        with self.assertRaises(HardwareError):
            self.guard.ingest_telemetry(payload)

    def test_wrong_calibration_blocks(self):
        payload = self.adapter.sample()
        payload["calibration_id"] = "not-the-approved-frame"
        self.guard.ingest_telemetry(payload)
        self.assertIn("calibration_mismatch", self.guard.status()["active_faults"])

    def test_old_future_and_backwards_measurements_rejected(self):
        for delta in (-2, 2):
            with self.subTest(delta=delta):
                payload = self.adapter.sample()
                payload["measured_at"] = datetime.fromtimestamp(self.clock.now + delta, timezone.utc).isoformat()
                with self.assertRaises(HardwareError):
                    self.guard.ingest_telemetry(payload)
        payload = self.adapter.sample()
        payload["measured_at"] = datetime.fromtimestamp(self.clock.now - .5, timezone.utc).isoformat()
        with self.assertRaises(HardwareError):
            self.guard.ingest_telemetry(payload)

    def test_target_validated_without_changing_position(self):
        original = self.guard.status()["telemetry"]["position_mm"]
        for target in ({"x": 1001, "y": 0, "z": 0}, {"x": 0, "y": 0, "z": -1},
                       {"x": 0, "y": 0, "z": float("inf")}):
            with self.assertRaises(HardwareError):
                self.guard.prepare_move("bad-target", target)
        command = self.guard.prepare_move("valid", {"x": 200, "y": 200, "z": 200})
        self.assertTrue(command["dry_run"])
        self.assertEqual(original, self.guard.status()["telemetry"]["position_mm"])

    def test_confirmation_requires_new_measurement_and_arrival(self):
        command = self.guard.prepare_move("move-1", {"x": 200, "y": 200, "z": 200})
        with self.assertRaises(HardwareError):
            self.guard.confirm(self.adapter.confirmation(command))
        self.adapter.emit(position_mm={"x": 100, "y": 200, "z": 200})
        with self.assertRaises(HardwareError):
            self.guard.confirm(self.adapter.confirmation(command))
        self.adapter.emit(position_mm=command["target_mm"])
        self.assertTrue(self.guard.confirm(self.adapter.confirmation(command)))

    def test_pick_and_place_confirmed_by_gripper(self):
        target = {"x": 200, "y": 200, "z": 200}
        pick = self.guard.prepare_move("pick-1", target, operation="pick", container_id="C001")
        self.adapter.emit(position_mm=target)
        with self.assertRaises(HardwareError):
            self.guard.confirm(self.adapter.confirmation(pick))
        self.adapter.emit(gripper="holding")
        self.assertTrue(self.guard.confirm(self.adapter.confirmation(pick)))
        with self.assertRaises(HardwareError):
            self.guard.prepare_move("pick-2", target, operation="pick", container_id="C002")
        place = self.guard.prepare_move("place-1", target, operation="place", container_id="C001")
        self.adapter.emit(gripper="empty")
        self.assertTrue(self.guard.confirm(self.adapter.confirmation(place)))
        with self.assertRaises(HardwareError):
            self.guard.prepare_move("place-2", target, operation="place", container_id="C001")

    def test_confirmation_identity_and_idempotency(self):
        command = self.guard.prepare_move("pick-1", {"x": 100, "y": 100, "z": 100},
                                          operation="pick", container_id="C001")
        self.adapter.emit(gripper="holding")
        confirmation = self.adapter.confirmation(command, event_id="event-1")
        for field in ("command_id", "container_id", "source", "session_id", "calibration_id", "kind"):
            with self.subTest(field=field):
                with self.assertRaises(HardwareError):
                    self.guard.confirm({**confirmation, field: "wrong"})
        self.assertTrue(self.guard.confirm(confirmation))
        self.assertFalse(self.guard.confirm(confirmation))
        with self.assertRaises(HardwareError):
            self.guard.confirm({**confirmation, "container_id": "C002"})

    def test_caller_cannot_mutate_samples_or_commands(self):
        payload = self.adapter.sample()
        self.guard.ingest_telemetry(payload)
        payload["position_mm"]["x"] = -100
        status = self.guard.status()
        status["telemetry"]["position_mm"]["x"] = -100
        self.assertEqual(self.guard.status()["telemetry"]["position_mm"]["x"], 100)
        command = self.guard.prepare_move("copy-test", {"x": 200, "y": 200, "z": 200})
        command["target_mm"]["x"] = -100
        self.assertEqual(self.guard.status()["pending_command"]["target_mm"]["x"], 200)

    def test_self_test_uses_only_isolated_mocks(self):
        before = deepcopy(self.guard.status())
        result = self_test()
        self.assertTrue(result["passed"])
        self.assertEqual(len(result["checks"]), 4)
        self.assertFalse(result["physical_commands_enabled"])
        self.assertEqual(before, self.guard.status())


if __name__ == "__main__":
    unittest.main()
