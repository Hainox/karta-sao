import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createDirectionRepository } from '../src/tpu-points/direction-corrections.js';

test('PostgreSQL: положение и направление сохраняются атомарно, конфликтующие версии отклоняются', {skip: !process.env.SLOT_TEST_DATABASE_URL}, async()=>{
  const schema='direction_test_'+Date.now();
  const pool=new pg.Pool({connectionString:process.env.SLOT_TEST_DATABASE_URL,options:'-c search_path='+schema});
  const audit=[];
  try {
    await pool.query('CREATE SCHEMA '+schema);
    await pool.query('CREATE TABLE users (id text PRIMARY KEY)');
    await pool.query('INSERT INTO users VALUES ($1)',['pref-test']);
    await pool.query(readFileSync(new URL('../migrations/016_district_direction_corrections.sql',import.meta.url),'utf8'));
    const write=async(actor,action,details,callback)=>{
      const client=await pool.connect();
      try {await client.query('BEGIN');const result=await callback(client);await client.query('COMMIT');audit.push({actor,action,details,id:result.id});return result;}
      catch(error){await client.query('ROLLBACK');throw error;}
      finally{client.release();}
    };
    const repo=createDirectionRepository(pool,write);
    const input={fid:8,longitude:37.566,latitude:55.875,azimuth:90,expectedVersion:0,actorId:'pref-test'};
    const row=await repo.updateDirectionCorrection(input);
    assert.equal(row.version,1);assert.equal(row.azimuth,90);
    const attempts=await Promise.allSettled([180,270].map(azimuth=>repo.updateDirectionCorrection({...input,azimuth,expectedVersion:1})));
    assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(attempts.find(r=>r.status==='rejected').reason.status,409);
    const saved=(await createDirectionRepository(pool,write).listDirectionCorrections({fids:[8]}))[0];
    assert.equal(saved.version,2);assert.equal(saved.longitude,input.longitude);assert.equal(saved.latitude,input.latitude);
    assert.ok([180,270].includes(saved.azimuth));
    assert.equal(audit.length,2);assert.equal(audit[0].action,'district_direction_corrected');assert.equal(audit[0].id,'direction180:8');
  } finally {await pool.query('DROP SCHEMA '+schema+' CASCADE');await pool.end();}
});
