"""Validated hardware contracts and an isolated mock; no motor transport exists.

Coordinates are measured millimetres in an explicitly calibrated frame. This
module never changes inventory and cannot establish physical machine safety.
"""
from copy import deepcopy
from datetime import datetime, timezone
import math
from threading import RLock
import time
import uuid

AXES = ("x", "y", "z")
SWITCHES = tuple(f"{axis}_{end}" for axis in AXES for end in ("min", "max"))
TELEMETRY_FIELDS = {
    "version", "source", "session_id", "sequence", "measured_at", "calibration_id",
    "position_mm", "homed", "limit_switches", "connected", "emergency_stop",
    "obstacle_clear", "gripper",
}
CONFIRMATION_FIELDS = {
    "event_id", "command_id", "kind", "container_id", "source", "session_id",
    "telemetry_sequence", "measured_at", "calibration_id",
}


class HardwareError(ValueError):
    """A contract violation or a locked command."""


def _number(value):
    return (not isinstance(value, bool) and isinstance(value, (int, float))
            and math.isfinite(value))


def _text(value):
    return isinstance(value, str) and 0 < len(value.strip()) <= 128


def _point(value):
    return (isinstance(value, dict) and set(value) == set(AXES)
            and all(_number(value[axis]) for axis in AXES))


def _timestamp(value):
    if not isinstance(value, str):
        raise HardwareError("Horodatage ISO 8601 requis.")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HardwareError("Horodatage ISO 8601 invalide.") from exc
    if result.tzinfo is None or result.utcoffset() is None:
        raise HardwareError("Le fuseau de l'horodatage est obligatoire.")
    return result.timestamp()


class HardwareGuard:
    """Fail-closed software gate. Only MockAdapter can exercise mock commands.

    Freshness is checked at ingestion and every status/command check. A fault
    remains latched after healthy telemetry returns until explicit resume.
    Limits/calibration are deliberately absent by default; animation geometry
    must never supply physical machine limits automatically.
    """

    def __init__(self, *, limits_mm=None, calibration_id=None, source="unconfigured",
                 session_id="unconfigured", timeout_s=1.0, tolerance_mm=0.5,
                 mock=False, clock=time.monotonic, wall_clock=time.time):
        if not _number(timeout_s) or timeout_s <= 0:
            raise HardwareError("Le délai de télémétrie doit être positif.")
        if not _number(tolerance_mm) or tolerance_mm < 0:
            raise HardwareError("Tolérance de position invalide.")
        if limits_mm is not None:
            if not isinstance(limits_mm, dict) or set(limits_mm) != set(AXES):
                raise HardwareError("Définir les courses x, y et z.")
            for bounds in limits_mm.values():
                if (not isinstance(bounds, (list, tuple)) or len(bounds) != 2
                        or not all(_number(v) for v in bounds) or bounds[0] >= bounds[1]):
                    raise HardwareError("Courses mécaniques invalides.")
        if calibration_id is not None and not _text(calibration_id):
            raise HardwareError("Version de calibration invalide.")
        if not _text(source) or not _text(session_id) or not isinstance(mock, bool):
            raise HardwareError("Identité d'adaptateur invalide.")
        self.limits_mm = deepcopy(limits_mm)
        self.calibration_id = calibration_id
        self.source, self.session_id = source, session_id
        self.timeout_s, self.tolerance_mm = timeout_s, tolerance_mm
        self.mock, self._clock, self._wall_clock = mock, clock, wall_clock
        self._telemetry = None
        self._received_at = None
        self._last_sequence = -1
        self._last_measured_at = None
        self._invalid_telemetry = False
        self._latched = {"explicit_start_required"}
        self._pending = None
        self._used_commands = set()
        self._confirmations = {}
        self._lock = RLock()

    def _trip(self, reason):
        self._latched.add(reason)
        # Never silently retry a command after a fault or reconnection.
        self._pending = None

    def _fresh_timestamp(self, value):
        stamp = _timestamp(value)
        age = self._wall_clock() - stamp
        if age > self.timeout_s or age < -0.1:
            raise HardwareError("Mesure périmée ou horloge non synchronisée.")
        return stamp

    def ingest_telemetry(self, payload):
        """Accept one complete sample. Malformed/replayed samples latch a stop."""
        with self._lock:
            # A late healthy packet must not conceal a preceding communication gap.
            if self._telemetry is not None:
                self.status()
            try:
                if not isinstance(payload, dict) or set(payload) != TELEMETRY_FIELDS:
                    raise HardwareError("Champs de télémétrie manquants ou inconnus.")
                if type(payload["version"]) is not int or payload["version"] != 1:
                    raise HardwareError("Version de télémétrie inconnue.")
                if payload["source"] != self.source or payload["session_id"] != self.session_id:
                    raise HardwareError("Source ou session matérielle inattendue.")
                sequence = payload["sequence"]
                if type(sequence) is not int or sequence < 0 or sequence <= self._last_sequence:
                    raise HardwareError("Télémétrie dupliquée ou désordonnée.")
                stamp = self._fresh_timestamp(payload["measured_at"])
                if self._last_measured_at is not None and stamp < self._last_measured_at:
                    raise HardwareError("Horodatage de mesure en recul.")
                if not _point(payload["position_mm"]):
                    raise HardwareError("Positions x, y, z finies requises.")
                for field, keys in (("homed", AXES), ("limit_switches", SWITCHES)):
                    value = payload[field]
                    if (not isinstance(value, dict) or set(value) != set(keys)
                            or not all(type(flag) is bool for flag in value.values())):
                        raise HardwareError(f"Signaux {field} incomplets ou invalides.")
                if not all(type(payload[key]) is bool for key in
                           ("connected", "emergency_stop", "obstacle_clear")):
                    raise HardwareError("Signaux de sécurité booléens requis.")
                if payload["gripper"] not in ("unknown", "empty", "holding"):
                    raise HardwareError("Retour de préhenseur inconnu.")
                if not _text(payload["calibration_id"]):
                    raise HardwareError("Version de calibration obligatoire.")
                self._telemetry = deepcopy(payload)
                self._received_at = self._clock()
                self._last_sequence, self._last_measured_at = sequence, stamp
                self._invalid_telemetry = False
            except (HardwareError, TypeError, OverflowError) as exc:
                self._invalid_telemetry = True
                self._trip("invalid_telemetry")
                raise HardwareError(str(exc)) from exc
            return self.status()

    def _active_faults(self):
        faults = []
        if self._invalid_telemetry:
            faults.append("invalid_telemetry")
        if self.limits_mm is None or not self.calibration_id:
            faults.append("calibration_missing")
        sample = self._telemetry
        if sample is None:
            return faults + ["telemetry_missing"]
        if (self._clock() - self._received_at > self.timeout_s
                or self._wall_clock() - self._last_measured_at > self.timeout_s):
            faults.append("telemetry_stale")
        if not sample["connected"]:
            faults.append("disconnected")
        if sample["emergency_stop"]:
            faults.append("emergency_stop")
        if not sample["obstacle_clear"]:
            faults.append("obstacle_detected")
        if not all(sample["homed"].values()):
            faults.append("homing_required")
        if any(sample["limit_switches"].values()):
            faults.append("limit_switch_active")
        if sample["gripper"] == "unknown":
            faults.append("gripper_unconfirmed")
        if sample["calibration_id"] != self.calibration_id:
            faults.append("calibration_mismatch")
        if self.limits_mm is not None and not self._inside_limits(sample["position_mm"]):
            faults.append("position_out_of_bounds")
        return faults

    def _inside_limits(self, point):
        return all(self.limits_mm[axis][0] <= point[axis] <= self.limits_mm[axis][1]
                   for axis in AXES)

    def status(self):
        with self._lock:
            faults = self._active_faults()
            for reason in faults:
                self._trip(reason)
            return {
                "adapter": "mock" if self.mock else "unconfigured",
                "physical_commands_enabled": False,
                "ready_for_mock_commands": self.mock and not self._latched,
                "requires_explicit_resume": bool(self._latched),
                "active_faults": faults, "latched_faults": sorted(self._latched),
                "calibration_id": self.calibration_id,
                "limits_mm": deepcopy(self.limits_mm),
                "telemetry": deepcopy(self._telemetry),
                "pending_command": deepcopy(self._pending),
            }

    def resume(self, *, operator_confirmed=False):
        with self._lock:
            status = self.status()
            if operator_confirmed is not True:
                raise HardwareError("Une reprise explicite est obligatoire.")
            if not self.mock:
                raise HardwareError("Aucun adaptateur matériel réel n'est installé.")
            if status["active_faults"]:
                raise HardwareError("Reprise bloquée : " + ", ".join(status["active_faults"]))
            self._latched.clear()
            return self.status()

    def emergency_stop(self):
        """Latch the software gate only; this is not an electrical E-stop."""
        with self._lock:
            self._trip("software_stop")
            return self.status()

    def prepare_move(self, command_id, target_mm, *, operation="move", container_id=None):
        """Prepare a MOCK intent. No I/O or inventory transaction takes place."""
        with self._lock:
            if not self.status()["ready_for_mock_commands"]:
                raise HardwareError("Commandes verrouillées.")
            if not _text(command_id) or command_id in self._used_commands:
                raise HardwareError("Identifiant de commande invalide ou déjà utilisé.")
            if self._pending is not None:
                raise HardwareError("Une commande attend déjà sa confirmation.")
            if not _point(target_mm) or not self._inside_limits(target_mm):
                raise HardwareError("Destination en dehors des courses configurées.")
            if operation not in ("move", "pick", "place"):
                raise HardwareError("Opération inconnue.")
            if operation != "move" and not _text(container_id):
                raise HardwareError("Conteneur identifié requis pour une prise ou un dépôt.")
            if operation == "pick" and self._telemetry["gripper"] != "empty":
                raise HardwareError("Préhenseur déjà chargé.")
            if operation == "place" and self._telemetry["gripper"] != "holding":
                raise HardwareError("Aucune prise confirmée sur le préhenseur.")
            self._used_commands.add(command_id)
            self._pending = dict(command_id=command_id, target_mm=deepcopy(target_mm),
                                 operation=operation, container_id=container_id,
                                 telemetry_sequence=self._last_sequence, dry_run=True)
            return deepcopy(self._pending)

    def confirm(self, payload):
        """Validate an observed result, deduplicate exact replays, return bool.

        True means a new mock event was accepted; False means the exact event
        was already accepted. No container is relocated by this method.
        """
        with self._lock:
            if not isinstance(payload, dict) or set(payload) != CONFIRMATION_FIELDS:
                raise HardwareError("Confirmation incomplète.")
            event_id = payload["event_id"]
            if not _text(event_id):
                raise HardwareError("Identifiant d'événement obligatoire.")
            if event_id in self._confirmations:
                if self._confirmations[event_id] != payload:
                    raise HardwareError("Identifiant d'événement réutilisé avec un autre contenu.")
                return False
            if not self.status()["ready_for_mock_commands"] or self._pending is None:
                raise HardwareError("Aucune commande confirmable.")
            command = self._pending
            expected_kind = {"move": "arrived", "pick": "picked", "place": "deposited"}[command["operation"]]
            if (payload["command_id"] != command["command_id"]
                    or payload["kind"] != expected_kind
                    or payload["container_id"] != command["container_id"]
                    or payload["source"] != self.source
                    or payload["session_id"] != self.session_id
                    or payload["calibration_id"] != self.calibration_id):
                raise HardwareError("Confirmation sans correspondance avec la commande.")
            sequence = payload["telemetry_sequence"]
            if (type(sequence) is not int or sequence != self._last_sequence
                    or sequence <= command["telemetry_sequence"]):
                raise HardwareError("Une nouvelle mesure est obligatoire pour confirmer.")
            if self._fresh_timestamp(payload["measured_at"]) < self._last_measured_at:
                raise HardwareError("Confirmation antérieure à la mesure.")
            position = self._telemetry["position_mm"]
            if any(abs(position[axis] - command["target_mm"][axis]) > self.tolerance_mm for axis in AXES):
                raise HardwareError("La position mesurée ne confirme pas la destination.")
            expected_gripper = {"pick": "holding", "place": "empty"}.get(command["operation"])
            if expected_gripper and self._telemetry["gripper"] != expected_gripper:
                raise HardwareError("Le capteur ne confirme pas la prise ou le dépôt.")
            self._confirmations[event_id] = deepcopy(payload)
            self._pending = None
            return True


class MockAdapter:
    """In-memory test double. Example limits have no physical meaning."""

    def __init__(self, *, clock=time.monotonic, wall_clock=time.time):
        self.guard = HardwareGuard(limits_mm={"x": (0, 1000), "y": (0, 500), "z": (0, 300)},
                                   calibration_id="mock-only-v1", source="isolated-mock",
                                   session_id=str(uuid.uuid4()), mock=True,
                                   clock=clock, wall_clock=wall_clock)
        self._sequence = 0
        self._sample = dict(position_mm={"x": 100, "y": 100, "z": 100},
                            homed={axis: True for axis in AXES},
                            limit_switches={key: False for key in SWITCHES},
                            connected=True, emergency_stop=False, obstacle_clear=True, gripper="empty")

    def sample(self, **changes):
        self._sample.update(deepcopy(changes))
        self._sequence += 1
        return {**deepcopy(self._sample), "version": 1, "source": self.guard.source,
                "session_id": self.guard.session_id, "sequence": self._sequence,
                "measured_at": datetime.fromtimestamp(self.guard._wall_clock(), timezone.utc).isoformat(),
                "calibration_id": self.guard.calibration_id}

    def emit(self, **changes):
        return self.guard.ingest_telemetry(self.sample(**changes))

    def confirmation(self, command, *, event_id=None):
        return dict(event_id=event_id or str(uuid.uuid4()), command_id=command["command_id"],
                    kind={"move": "arrived", "pick": "picked", "place": "deposited"}[command["operation"]],
                    container_id=command["container_id"], source=self.guard.source,
                    session_id=self.guard.session_id, telemetry_sequence=self._sequence,
                    measured_at=datetime.fromtimestamp(self.guard._wall_clock(), timezone.utc).isoformat(),
                    calibration_id=self.guard.calibration_id)


def self_test():
    """Short, deterministic diagnostics in a new mock instance for each fault."""
    results = []
    for name, bad, good in (
        ("Arrêt d'urgence et reprise explicite", {"emergency_stop": True}, {"emergency_stop": False}),
        ("Perte de connexion et reprise explicite", {"connected": False}, {"connected": True}),
        ("Fin de course et reprise explicite", {"limit_switches": {key: key == "x_max" for key in SWITCHES}},
         {"limit_switches": {key: False for key in SWITCHES}}),
        ("Obstacle et reprise explicite", {"obstacle_clear": False}, {"obstacle_clear": True}),
    ):
        adapter = MockAdapter()
        adapter.emit()
        adapter.guard.resume(operator_confirmed=True)
        stopped = not adapter.emit(**bad)["ready_for_mock_commands"]
        still_stopped = not adapter.emit(**good)["ready_for_mock_commands"]
        resumed = adapter.guard.resume(operator_confirmed=True)["ready_for_mock_commands"]
        results.append(dict(name=name, passed=stopped and still_stopped and resumed))
    return dict(passed=all(item["passed"] for item in results), adapter="isolated-mock",
                physical_commands_enabled=False, checks=results)
