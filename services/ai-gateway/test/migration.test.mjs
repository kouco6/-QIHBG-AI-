import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { AccountsService } from '../src/workbench/accounts/service.mjs';
import { CollabService } from '../src/workbench/collab/service.mjs';
import { createAccountsApi } from '../src/workbench/accounts/api.mjs';
const fixture = fn => {
 const root = mkdtempSync(join(tmpdir(),'ai-migration-'));
 try { return fn(root) } finally {rmSync(root,{recursive:true,force:true})}
};
test('research originals, ownership, project and model survive persistent restart',()=>fixture(root=>{
 const store=new TaskStore({file:join(root,'tasks.jsonl')});
 const manager=new TaskManager({concurrency:1,timeoutMs:500,runner:async()=>{throw Error('must not execute')},persist:(t,k)=>store.append(t,k)});
 const research={transport:'local-pull',memberId:'legacy-id',localPull:{phase:'queued'}};
 const input={prompt:'原始输入'.repeat(20000),research,skills:['original'],ownerAccountId:'owner',modelId:'model',modelName:'模型',projectId:'project'};
 const {task}=manager.create(input,'research-key',{draft:true});
 manager.researchTransition(task.id,{status:'queued',finalResponse:'原始输出'.repeat(20000)});
 const loaded=store.load();const fresh=new TaskManager({concurrency:1,timeoutMs:500,runner:async()=>{},persist:(t,k)=>store.append(t,k),maxTasks:0});
 fresh.restore(loaded.latest,loaded.idempotency,loaded.eventsByTask);
 const restored=fresh.get(task.id);assert.equal(restored.status,'queued');assert.equal(restored.prompt,input.prompt);
 assert.equal(restored.finalResponse,'原始输出'.repeat(20000));assert.equal(restored.ownerAccountId,'owner');assert.equal(restored.projectId,'project');assert.equal(restored.modelId,'model');assert.deepEqual(restored.research,research);
 assert.deepEqual(restored.skills,['original']);assert.ok(fresh.queue.includes(task.id));
 assert.throws(()=>fresh.dispatch(task.id),/本地领取/);assert.throws(()=>fresh.update(task.id,{label:'bad'}),/只读/);assert.throws(()=>fresh.rerun(task.id),/新任务版本/);
 fresh.archive(task.id);assert.equal(fresh.get(task.id).status,'queued');
}));
test('research persistence fails closed before dispatch',()=>{
 const manager=new TaskManager({concurrency:1,timeoutMs:500,runner:async()=>{},persist:()=>{throw Error('disk full')}});
 assert.throws(()=>manager.create({prompt:'research',research:{transport:'local-pull'}},null,{draft:true}),/disk full/);assert.equal(manager.tasks.size,0);
 const store=new TaskStore({file:null});assert.throws(()=>store.append({research:{}}),/persistence/);
});
test('remote claim, completion and ordinary task metadata survive restart',()=>fixture(root=>{
 const store=new TaskStore({file:join(root,'tasks.jsonl')});
 const manager=new TaskManager({concurrency:1,timeoutMs:500,runner:async()=>{},persist:(t,k)=>store.append(t,k)});
 const t=manager.create({prompt:'remote synthetic',runner:'remote',ownerAccountId:'one',modelId:'m',modelName:'Model',skills:['skill'],projectId:'p'}).task;
 assert.equal(manager.claimRemote('other'),null);assert.equal(manager.claimRemote('one').id,t.id);
 manager.remoteProgress(t.id,'synthetic');manager.finishRemote(t.id,{ok:true,finalResponse:'# 合成成果'});
 const record=store.load().latest[0];assert.equal(record.status,'completed');assert.equal(record.runner,'remote');assert.equal(record.modelId,'m');assert.equal(record.projectId,'p');assert.deepEqual(record.skills,['skill']);
}));
test('legacy members without role migrate with original ID, token and active compatibility',()=>fixture(root=>{
 const token='cb_synthetic';const db=new DatabaseSync(join(root,'collab.db'));
 db.exec('CREATE TABLE collab_members(id TEXT,name TEXT,token_hash TEXT,token_hint TEXT,active INTEGER,created_at TEXT)');
 db.prepare('INSERT INTO collab_members VALUES(?,?,?,?,1,?)').run('old-id','旧成员',createHash('sha256').update(token).digest('hex'),'test','2026-01-01');db.close();
 const accounts=new AccountsService({stateDir:root});accounts.boot();
 const collab=new CollabService({stateDir:root,accounts});collab.boot();
 try {assert.equal(accounts.migrateFromMembers(collab.legacyMembers()),1);assert.equal(accounts.migrateFromMembers(collab.legacyMembers()),0);assert.equal(collab.memberByToken(token).id,'old-id');assert.equal(collab.listMembers()[0].active,1)} finally {collab.shutdown();accounts.shutdown()}
}));
test('platform rename/demotion preserves identity and revokes gateway sessions',()=>fixture(root=>{
 const accounts=new AccountsService({stateDir:root});accounts.boot();
 try {const a=accounts.syncPlatformAccount({username:'member',name:'旧名',role:'admin'});const session=accounts.createSession(a.id);
 const b=accounts.syncPlatformAccount({username:'member',name:'新名',role:'other'});assert.equal(a.id,b.id);assert.equal(b.name,'新名');assert.equal(b.role,'other');assert.equal(accounts.accountBySession(session),null)}finally{accounts.shutdown()}
}));
test('transport token does not grant integrated users administrator account APIs',async()=>{
 const account={id:'ordinary',role:'other'};
 const api=createAccountsApi({service:{},authorized:()=>false,integration:()=>account,platformManaged:true});
 const req={headers:{},method:'GET'};const res={writeHead(status){this.status=status},end(s){this.body=JSON.parse(s)}};
 await api.handle(req,res,'/api/auth/accounts',new URL('http://test/api/auth/accounts'));assert.equal(res.status,401);
 req.method='POST';await api.handle(req,res,'/api/auth/login',new URL('http://test/api/auth/login'));assert.equal(res.status,409);
});

test('restart retains queued remote jobs when old terminal records fill the limit',()=>{
 const manager=new TaskManager({concurrency:1,timeoutMs:500,runner:async()=>{},maxTasks:1});
 manager.restore([{id:'old',status:'completed'},{id:'remote',runner:'remote',status:'queued',ownerAccountId:'owner'},{id:'latest',status:'completed'}],new Map());
 assert.ok(manager.get('remote'));assert.equal(manager.claimRemote('owner').id,'remote');assert.equal(manager.get('old'),null);
});
test('platform usernames up to 64 characters map idempotently',()=>fixture(root=>{
 const service=new AccountsService({stateDir:root});service.boot();
 try {const username='a'.repeat(64);const a=service.syncPlatformAccount({username,name:'长账号',role:'other'});assert.equal(a.username,username);assert.equal(service.syncPlatformAccount({username,name:'长账号',role:'other'}).id,a.id)}finally{service.shutdown()}
}));
