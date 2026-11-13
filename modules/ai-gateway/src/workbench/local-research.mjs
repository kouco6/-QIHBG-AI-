/** WorkBuddy pull transport over existing collaboration identities and TaskManager.
 * No second queue, model call, WorkBuddy API or host CLI is created here.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ExecutorError, loadResearchSkill, selectExecutor, executorCatalog, sha256 } from "./research-executors.mjs";
import { finishResearchFiles, researchView } from "./research.mjs";
import { collectArtifacts } from "./artifacts.mjs";
const fail=(code,message,status=409)=>{throw new ExecutorError(code,message,status);};
const ID=/^[A-Za-z0-9._-]{1,120}$/;
const TERMINAL=new Set(["completed","failed","cancelled"]);
export class LocalResearch {
  constructor({manager,collab,config,ownerId,now=Date.now,nativeEvidenceVerifier=null}) {
    Object.assign(this,{manager,collab,config,ownerId,now,nativeEvidenceVerifier});
  }
  settings() {
    if (this.config.researchLocal) return {...this.config.researchLocal,verifierReady:Boolean(this.nativeEvidenceVerifier)};
    const path=join(dirname(this.config.stateFile),"local-research.json");
    if (!existsSync(path)) return {enabled:false};
    if (lstatSync(path).isSymbolicLink() || lstatSync(path).size>65536) fail("RESEARCH_CONFIG_INVALID","本地研究配置无效",503);
    try{return {...JSON.parse(readFileSync(path,"utf8")),verifierReady:Boolean(this.nativeEvidenceVerifier)};}
    catch{fail("RESEARCH_CONFIG_INVALID","本地研究配置不能解析",503);}
  }
  info() {
    const settings=this.settings();
    let skill=null,error=null;
    try { if(settings.enabled===true) skill=loadResearchSkill(settings); }
    catch(e){error=e.code??"SKILL_PACKAGE_INVALID";}
    return {enabled:settings.enabled===true,executorId:"workbuddy-local",transport:"local-pull",
      oauthRequired:false,verificationMode:settings.verificationMode===true,
      capabilityVerified:settings.capabilityVerified===true&&settings.verifierReady,nativeEvidenceVerifierReady:Boolean(this.nativeEvidenceVerifier),
      executors:executorCatalog(settings),skill,error,leaseSeconds:this.ttl(settings),
      taskCreationEnabled:settings.enabled===true&&!error&&Boolean(this.member(settings.memberId))&&
        Array.isArray(settings.allowedProjectIds)&&settings.allowedProjectIds.length>0&&
        (settings.verificationMode===true||(settings.capabilityVerified===true&&settings.verifierReady)),
      automaticSelectionEnabled:settings.capabilityVerified===true&&settings.verifierReady,
      researchSuccessVerified:false};
  }
  ttl(settings=this.settings()){return Math.min(3600,Math.max(60,Number(settings.leaseSeconds)||1800));}
  member(id){return this.collab.listMembers().find(m=>m.id===id&&m.active===1);}
  owned(task,member) {
    return Boolean(task?.research?.transport==="local-pull"&&task.research.ownerId===this.ownerId&&
      task.research.memberId===member.id);
  }
  requireTask(id,member) {
    const task=this.manager.tasks.get(id);
    if(!this.owned(task,member)) fail("RESEARCH_TASK_NOT_FOUND","当前成员没有此研究任务权限",404);
    return task;
  }
  transition(task,patch){
    return this.manager.researchTransition(task.id,patch);
  }
  admit(body,key) {
    const settings=this.settings();
    selectExecutor(settings,{selectionMode:body.selectionMode??"manual",executorId:body.executorId??"workbuddy-local"});
    const skill=loadResearchSkill(settings),r=body.research??{};
    if(r.dimensionId!=="DIM-03"||r.schemaVersion!=="v5"||![r.projectId,r.cycleId].every(v=>typeof v==="string"&&ID.test(v)))
      fail("INVALID_RESEARCH_CONTEXT","研究项目、维度或周期无效",422);
    if(!Array.isArray(settings.allowedProjectIds)||!settings.allowedProjectIds.includes(r.projectId))
      fail("RESEARCH_PROJECT_NOT_AUTHORIZED","项目未获本地执行授权",403);
    const memberId=body.executorMemberId??settings.memberId;
    if(!this.member(memberId))fail("RESEARCH_MEMBER_NOT_AUTHORIZED","需指定本账号内有效协作成员",403);
    if(r.skillVersion!==null&&r.skillVersion!==skill.version)fail("SKILL_VERSION_MISMATCH","Skill 版本不匹配");
    if(!/^[A-Za-z0-9._:-]{8,128}$/.test(key??""))fail("INVALID_IDEMPOTENCY_KEY","幂等键无效",422);
    const context=body.projectContext??{};
    const input={projectContext:Object.fromEntries(["id","name","type","background"].map(k=>[k,context[k]??null])),
      supplement:typeof body.supplement==="string"?body.supplement:""};
    const inputHash=sha256(JSON.stringify([r,input,memberId,skill.packageSha256]));
    const scopedKey="research:"+sha256(JSON.stringify([this.ownerId,r.projectId,r.dimensionId,r.cycleId,key]));
    const old=this.manager.tasks.get(this.manager.idempotency.get(scopedKey));
    if(old){
      if(old.research.inputHash!==inputHash)fail("IDEMPOTENCY_CONFLICT","同一幂等键不能改变输入");
      if(old.status==="draft")fail("RESEARCH_PERSISTENCE_FAILED","任务入队检查点未完成，保留原任务待核查",503);
      return {status:200,value:{accepted:true,duplicate:true,...researchView(old)}};
    }
    const same=[...this.manager.tasks.values()].filter(t=>t.research?.ownerId===this.ownerId&&
      t.research.projectId===r.projectId&&t.research.dimensionId===r.dimensionId);
    if(same.some(t=>!TERMINAL.has(t.status)))fail("DIMENSION_TASK_ACTIVE","该维度仍有未确认终结的研究，不重复派发");
    const version=1+Math.max(0,...same.map(t=>Number(t.research.version)||0));
    const created=this.manager.create({agent:"workbuddy",agentChoice:"manual",label:"DIM-03 本地研究",
      prompt:JSON.stringify(input),mode:"read-only",taskType:"planning_research",outputTypes:["markdown","json"],
      research:{...r,ownerId:this.ownerId,memberId,version,inputHash,executor:"workbuddy-local",transport:"local-pull",
        skillName:skill.name,skillVersion:skill.version,skillSha256:skill.sha256,skillPackageSha256:skill.packageSha256,
        skillFiles:skill.files,verificationOnly:!(settings.capabilityVerified&&settings.verifierReady),
        localPull:{phase:"queued",claim:null}}},scopedKey,{draft:true});
    const task=this.manager.tasks.get(created.task.id);
    try{this.transition(task,{status:"queued",queuedAt:new Date(this.now()).toISOString()});}
    catch{fail("RESEARCH_PERSISTENCE_FAILED","任务入队未可靠保存，未派发",503);}
    return {status:202,value:{accepted:true,duplicate:false,...researchView(task)}};
  }
  expire(task) {
    const claim=task.research.localPull.claim;
    if(claim&&claim.expiresAt<=this.now()&&task.status==="running")
      this.transition(task,{status:"interrupted",error:"LEASE_EXPIRED_REVIEW_REQUIRED",
        research:{...task.research,localPull:{...task.research.localPull,phase:"lease-expired-awaiting-confirmation"}}});
  }
  pending(member) {
    const items=[];
    for(const task of this.manager.tasks.values())if(this.owned(task,member)){
      this.expire(task);
      if(task.status==="queued"&&!task.research.localPull.claim)
        items.push({taskId:task.id,projectId:task.research.projectId,dimensionId:task.research.dimensionId,
          cycleId:task.research.cycleId,resultVersion:task.research.version,skillVersion:task.research.skillVersion,
          schemaVersion:task.research.schemaVersion,skillPackageSha256:task.research.skillPackageSha256});
    }
    return {items,executorId:"workbuddy-local",oauthRequired:false};
  }
  claim(id,member,body) {
    const task=this.requireTask(id,member);this.expire(task);
    if(typeof body.claimId!=="string"||!ID.test(body.claimId)||typeof body.leaseToken!=="string"||
      !/^[A-Za-z0-9_-]{32,128}$/.test(body.leaseToken))fail("INVALID_CLAIM","领取请求无效",422);
    const state=task.research.localPull,old=state.claim;
    if(old) {
      if(task.status==="running"&&old.id===body.claimId&&old.tokenHash===sha256(body.leaseToken)&&old.expiresAt>this.now())
        return this.packet(task,true);
      fail("TASK_ALREADY_CLAIMED","任务已领取或租约待核查，不能再次领取");
    }
    if(task.status!=="queued")fail("TASK_NOT_QUEUED","当前任务不可领取");
    if([...this.manager.tasks.values()].some(t=>t.id!==id&&this.owned(t,member)&&t.research.localPull.claim&&!TERMINAL.has(t.status)))
      fail("MEMBER_TASK_ACTIVE","本成员仍有未终结研究");
    const skill=loadResearchSkill(this.settings());
    if(body.skillPackageSha256!==skill.packageSha256||task.research.skillPackageSha256!==skill.packageSha256)
      fail("SKILL_VERSION_MISMATCH","领取前 Skill 完整包摘要不符，不执行");
    const claim={id:body.claimId,tokenHash:sha256(body.leaseToken),expiresAt:this.now()+this.ttl()*1000,uploads:{}};
    this.transition(task,{status:"running",startedAt:new Date(this.now()).toISOString(),
      research:{...task.research,localPull:{phase:"claimed",claim}}});
    return this.packet(task,false);
  }
  packet(task,duplicate) {
    const r=task.research;
    return {taskId:task.id,projectId:r.projectId,dimensionId:r.dimensionId,cycleId:r.cycleId,
      resultVersion:r.version,skillName:r.skillName,skillVersion:r.skillVersion,schemaVersion:r.schemaVersion,
      skillPackageSha256:r.skillPackageSha256,skillFiles:r.skillFiles,claimId:r.localPull.claim.id,
      leaseExpiresAt:r.localPull.claim.expiresAt,input:JSON.parse(task.prompt),duplicate,
      requirement:"必须由原生 Skill 工具执行；读取 SKILL.md、普通聊天或旧报告复制不算研究"};
  }
  leased(id,member,headers) {
    const task=this.requireTask(id,member);this.expire(task);
    const claim=task.research.localPull.claim;
    if(!claim||claim.id!==headers["x-research-claim"]||claim.tokenHash!==sha256(String(headers["x-research-lease"]??"")))
      fail("RESEARCH_LEASE_FORBIDDEN","执行租约不属于当前请求",403);
    if(claim.expiresAt<=this.now())fail("RESEARCH_LEASE_EXPIRED","租约过期，保留原任务待核查");
    if(task.status==="interrupted"&&task.research.localPull.phase!=="awaiting-native-verification")
      fail("RESEARCH_EXECUTION_REVIEW_REQUIRED","执行中断，需人工核查，不自动恢复或重复派发");
    if(TERMINAL.has(task.status)&&task.status!=="completed")fail("RESEARCH_TASK_TERMINAL","研究任务已经终结");
    return task;
  }
  heartbeat(id,member,headers) {
    const task=this.leased(id,member,headers),p=task.research.localPull;
    if(task.status!=="running")fail("RESEARCH_EXECUTION_REVIEW_REQUIRED","已交付或中断任务不能恢复运行");
    this.transition(task,{research:{...task.research,localPull:{...p,claim:{...p.claim,expiresAt:this.now()+this.ttl()*1000}}}});
    return {taskId:id,status:task.status,leaseExpiresAt:task.research.localPull.claim.expiresAt};
  }
  report(id,member,headers,body) {
    const task=this.leased(id,member,headers),p=task.research.localPull;
    if(task.status!=="running")fail("RESEARCH_EXECUTION_REVIEW_REQUIRED","已交付或中断任务不能恢复运行");
    if(!["skill-loaded","researching","waiting-permission","failed"].includes(body.phase))
      fail("INVALID_EXECUTION_STATE","执行状态无效，成功只能由双成果提交产生",422);
    if(body.phase==="skill-loaded"&&(
      body.skillName!==task.research.skillName||body.skillVersion!==task.research.skillVersion||
      body.skillPackageSha256!==task.research.skillPackageSha256||typeof body.nativeEvidenceRef!=="string"||
      !body.nativeEvidenceRef.trim()||body.nativeEvidenceRef.length>512))
      fail("NATIVE_SKILL_EVIDENCE_REQUIRED","需关联真实原生 Skill 调用证据",422);
    const evidence=body.phase==="skill-loaded"?{source:"worker-reported-native-call",ref:body.nativeEvidenceRef,
      reportedAt:new Date(this.now()).toISOString(),verified:false}:p.nativeEvidence;
    this.transition(task,{status:body.phase==="failed"?"interrupted":"running",
      error:body.phase==="failed"?"WORKER_REPORTED_FAILURE_REVIEW_REQUIRED":null,
      research:{...task.research,localPull:{...p,phase:body.phase,nativeEvidence:evidence??null}}});
    return {taskId:id,status:task.status,nativeInvocationVerified:false};
  }
  upload(id,member,headers,role,bytes) {
    const task=this.leased(id,member,headers),p=task.research.localPull;
    if(!["md","json"].includes(role)||bytes.length===0||bytes.length>8*1024*1024)fail("INVALID_RESEARCH_FILE","成果文件无效或超限，不截断",422);
    new TextDecoder("utf-8",{fatal:true}).decode(bytes);
    const digest=sha256(bytes),old=p.claim.uploads[role];
    if(old){if(old.sha256!==digest)fail("RESEARCH_FILE_IMMUTABLE","同一任务版本的原件不能覆盖");return {...old,duplicate:true};}
    if(task.status!=="running")fail("RESEARCH_EXECUTION_REVIEW_REQUIRED","已交付或中断任务不能新增原件");
    const push=this.collab.ingest({token:headers.authorization.replace(/^Bearer\s+/i,""),taskId:id,
      agent:"workbuddy-local",kind:"artifact",title:"研究原件 "+role,
      file:{name:role==="md"?"research.md":"research.json",mime:role==="md"?"text/markdown":"application/json",data:bytes}});
    const entry={pushId:push.id,sha256:digest,bytes:bytes.length};
    this.transition(task,{research:{...task.research,localPull:{...p,phase:"receiving-files",
      claim:{...p.claim,uploads:{...p.claim.uploads,[role]:entry}}}}});
    return entry;
  }
  async complete(id,member,headers,body) {
    const task=this.leased(id,member,headers),r=task.research,p=r.localPull,files=p.claim.uploads;
    if(loadResearchSkill(this.settings()).packageSha256!==r.skillPackageSha256)
      fail("SKILL_VERSION_MISMATCH","执行期间正式 Skill 包变化，保留原任务待核查");
    if(body.taskId!==id||body.resultVersion!==r.version||body.skillVersion!==r.skillVersion||
      body.schemaVersion!==r.schemaVersion||body.skillPackageSha256!==r.skillPackageSha256)
      fail("RESEARCH_DELIVERY_BINDING_MISMATCH","双成果任务、版本或 Skill 关联不符",422);
    if(!files.md||!files.json||body.mdSha256!==files.md.sha256||body.jsonSha256!==files.json.sha256)
      fail("RESEARCH_PAIR_INCOMPLETE","必须同任务同版本收到完整 MD 与 JSON 并匹配摘要",422);
    const md=this.collab.readFile(files.md.pushId)?.data,json=this.collab.readFile(files.json.pushId)?.data;
    if(!md||!json||sha256(md)!==files.md.sha256||sha256(json)!==files.json.sha256)
      fail("RESEARCH_FILE_INTEGRITY_FAILED","原件缺失或摘要不符",422);
    if(task.status==="completed")return {taskId:id,status:"completed",duplicate:true,...researchView(task)};
    if(!r.delivery)finishResearchFiles(this.config,task,md.toString("utf8"),json.toString("utf8"));
    const verified=Boolean(this.nativeEvidenceVerifier&&p.nativeEvidence&&
      await this.nativeEvidenceVerifier({task,evidence:p.nativeEvidence,claimId:p.claim.id}));
    this.leased(id,member,headers); // A slow verifier cannot revive an expired lease.
    const directory=join(dirname(this.config.stateFile),"research",id,"v"+r.version);
    const artifacts=collectArtifacts({declared:[{path:join(directory,"research.md")},{path:join(directory,"research.json")}],
      cwd:directory,runId:p.claim.id,agent:r.executor,scan:false});
    const result=this.transition(task,{status:verified?"completed":"interrupted",artifacts,
      finishedAt:verified?new Date(this.now()).toISOString():null,
      error:verified?null:"NATIVE_EXECUTION_VERIFICATION_REQUIRED",
      research:{...r,localPull:{...p,phase:verified?"completed":"awaiting-native-verification",nativeVerified:verified}}});
    return {taskId:id,status:result.status,technicalDeliveryComplete:true,nativeInvocationVerified:verified,
      resultAvailable:verified,verificationRequired:!verified};
  }
}
