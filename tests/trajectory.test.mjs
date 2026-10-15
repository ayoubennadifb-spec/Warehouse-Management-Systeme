import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DEFAULT_CONFIG} from '../dist/core.js';
import {planTrajectory,positionAlongRoute} from '../dist/trajectory.js';
const cases=JSON.parse(fs.readFileSync(new URL('./trajectory_cases.json',import.meta.url),'utf8'));
for(const c of cases)test(c.name,()=>{
  if(c.error)return assert.throws(()=>planTrajectory(DEFAULT_CONFIG,c.start,c.end,c.obstacles));
  const route=planTrajectory(DEFAULT_CONFIG,c.start,c.end,c.obstacles);
  assert.equal(route.routeLengthMm,c.length);
  assert.equal(route.cruiseHeightMm,c.height);
  assert.deepEqual(positionAlongRoute(route.waypoints,0),c.start);
  assert.deepEqual(positionAlongRoute(route.waypoints,1),c.end);
  for(let i=0;i<=100;i++){
    const p=positionAlongRoute(route.waypoints,i/100);
    for(const o of c.obstacles){
      const overlap=p.x<o.x+o.length-1e-7&&p.x+100>o.x+1e-7&&p.y<o.y+o.width-1e-7&&p.y+50>o.y+1e-7;
      assert.ok(!(overlap&&p.z<o.top-1e-7));
    }
  }
});
