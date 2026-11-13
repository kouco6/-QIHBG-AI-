/** Native Codex research on the existing AppServerRunner and TaskManager. */
import {cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {loadResearchSkill, sha256} from "./research-executors.mjs";
import {finishResearchFiles, researchView, ResearchFailure} from "./research.mjs";

const DIM03={name:"dim03-cert-completeness",version:"v0.1.0",sha256:"f175ba68634b4fb1527d8f59b0893f0bfbfa7e78536ead13d4190f98bdedf54c"};
const bundledRoot=fileURLToPath(new URL("../../research-skills/",import.meta.url));
const terminal=new Set(["completed","failed","cancelled"]);
const fail=(code,message,status=503)=>{throw new ResearchFailure(code,message,status);};
const samePath=(a,b)=>{try{return realpathSync(a)===realpathSync(b);}catch{return false;}};
const validId=x=>typeof x==="string"&&/^[A-Za-z0-9._-]{1,120}$/.test(x);
export class CodexResearch {
  constructor({config,manager,client,runner,ownerId}) {Object.assign(this,{config,manager,client,runner,ownerId});}
  settings() {
    if(this.config.researchCodex)return this.config.researchCodex;
    const path=join(dirname(this.config.stateFile),"codex-research.json");
    if(!existsSync(path))return {enabled:false};
    if(lstatSync(path).isSymbolicLink()||lstatSync(path).size>65536)fail("CODEX_RESEARCH_CONFIG_INVALID","Codex研究配置无效");
    try{return JSON.parse(readFileSync(path,"utf8"));}catch{fail("CODEX_RESEARCH_CONFIG_INVALID","Codex研究配置无法解析");}
  }
  skill() {return loadResearchSkill({skillRoot:bundledRoot,skill:DIM03});}
  info() {
    const settings=this.settings(); let skill=null,error=null;
    try{skill=this.skill();}catch(e){error=e.code;}
    return {enabled:settings.enabled===true,executorId:"codex-local",transport:"app-server-native-skill",
      taskCreationEnabled:settings.enabled===true&&!error,
      nativeProtocolImplemented:true,researchSuccessVerified:false,skill,error,
      authorization:"checked-at-admission",dimensions:Array.from({length:12},(_,i)=>({
        dimensionId:`DIM-${String(i+1).padStart(2,"0")}`,skillName:i===2?skill?.name:null,
        skillVersion:i===2?skill?.version:null,schemaVersion:i===2?"v5":null,
        skillStatus:i===2&&!error?"integrity-checked":"professional-skill-not-configured",
        enabled:i===2&&settings.enabled===true&&!error}))};
  }
  async admit(body,key) {
    const settings=this.settings(),r=body.research??{};
    if(settings.enabled!==true)fail("CODEX_RESEARCH_NOT_CONFIGURED","Codex专业研究尚未启用");
    if(body.executorId&&body.executorId!=="codex-local")fail("EXECUTOR_SELECTION_CONFLICT","本环境已指定Codex专业研究，不隐式切换执行主体",422);
    if(r.dimensionId!=="DIM-03")fail("PROFESSIONAL_SKILL_NOT_CONFIGURED","该维度的原生专业Skill及结构适配尚未交付，未用其他维度代替");
    if(!validId(r.projectId)||!validId(r.cycleId)||r.schemaVersion!=="v5")fail("INVALID_RESEARCH_CONTEXT","研究上下文无效",422);
    if(settings.allowOwnedProjects!==true&&(!Array.isArray(settings.allowedProjectIds)||!settings.allowedProjectIds.includes(r.projectId)))
      fail("RESEARCH_PROJECT_NOT_AUTHORIZED","项目未获本环境研究授权",403);
    const skill=this.skill();
    if(r.skillVersion!==null&&r.skillVersion!==skill.version)fail("SKILL_VERSION_MISMATCH","Skill版本不符",409);
    if(typeof key!=="string"||!/^[A-Za-z0-9._:-]{8,128}$/.test(key))fail("INVALID_IDEMPOTENCY_KEY","幂等键无效",422);
    const context=body.projectContext??{};
    const input={projectContext:Object.fromEntries(["id","name","type","background"].map(k=>[k,context[k]??null])),supplement:body.supplement??""};
    const hash=sha256(JSON.stringify([r,input,skill.packageSha256]));
    const scoped="research:"+sha256(JSON.stringify([this.ownerId,r.projectId,r.dimensionId,r.cycleId,key]));
    const prior=this.manager.tasks.get(this.manager.idempotency.get(scoped));
    if(prior){
      if(prior.research.inputHash!==hash)fail("IDEMPOTENCY_CONFLICT","同一幂等键的研究输入发生变化",409);
      return {status:200,value:{accepted:true,duplicate:true,...researchView(prior)}};
    }
    const same=[...this.manager.tasks.values()].filter(t=>t.research?.ownerId===this.ownerId&&t.research.projectId===r.projectId&&t.research.dimensionId===r.dimensionId);
    if(same.some(t=>!terminal.has(t.status)))fail("DIMENSION_TASK_ACTIVE","同维度有未结束任务",409);
    // Ask the native service; never inspect, copy or return authentication files.
    const auth=await this.client.request("account/read",{refreshToken:false});
    if(!auth.account)fail("CODEX_AUTHENTICATION_REQUIRED","当前网关运行身份尚未授权Codex研究",401);
    const repeated=this.manager.tasks.get(this.manager.idempotency.get(scoped));
    if(repeated){
      if(repeated.research.inputHash!==hash)fail("IDEMPOTENCY_CONFLICT","同一幂等键的研究输入发生变化",409);
      return {status:200,value:{accepted:true,duplicate:true,...researchView(repeated)}};
    }
    // Serialize the admission after the async auth boundary to protect races.
    if([...this.manager.tasks.values()].some(t=>t.research?.ownerId===this.ownerId&&t.research.projectId===r.projectId&&t.research.dimensionId===r.dimensionId&&!terminal.has(t.status)))
      fail("DIMENSION_TASK_ACTIVE","同维度已有任务受理",409);
    const version=1+Math.max(0,...same.map(t=>Number(t.research.version)||0));
    const created=this.manager.create({agent:"codex",agentChoice:"manual",label:"DIM-03 证书资质全 · 原生研究",
      prompt:JSON.stringify(input),mode:"read-only",taskType:"planning_research",skills:[skill.name],outputTypes:["markdown","json"],
      research:{...r,ownerId:this.ownerId,version,inputHash:hash,executor:"codex-local",transport:"app-server",
        skillName:skill.name,skillVersion:skill.version,skillSha256:skill.sha256,skillPackageSha256:skill.packageSha256,
        skillFiles:skill.files}},scoped,{draft:true});
    const task=this.manager.tasks.get(created.task.id);
    try{
      const cwd=join(dirname(this.config.stateFile),"research-work",task.id);
      mkdirSync(join(cwd,".agents","skills"),{recursive:true,mode:0o700});
      cpSync(join(bundledRoot,skill.name),join(cwd,".agents","skills",skill.name),{recursive:true,errorOnExist:true,force:false});
      writeFileSync(join(cwd,"input.json"),JSON.stringify({...input,taskId:task.id,resultVersion:version,...r},null,2),{flag:"wx",mode:0o400});
      const path=join(cwd,".agents","skills",skill.name,"SKILL.md");
      const prompt=`$${skill.name}\n使用本次原生Skill执行专业研究。仅以本目录input.json的项目基础资料和supplement为业务输入；不得读取既有W、其他项目、历史报告或凭证。任务ID=${task.id}，成果版本=${version}。\n使用实时web搜索与原文核验，完整执行研究规则。完成后最终回复必须是严格JSON对象，仅含markdown和jsonText两个字符串：markdown为完整MD研究档案；jsonText为严格v5 JSON的原始完整文本。不要输出代码围栏。由网关原样归档两个字符串，不写W/D/P。若无检索能力或无法完成研究，明确失败，不交空成果冒充成功。`;
      this.manager.researchTransition(task.id,{cwd,prompt,research:{...task.research,nativeSkill:{path},phase:"queued"}});
      this.manager.dispatch(task.id);
    }catch(error){
      this.manager.researchTransition(task.id,{status:"failed",error:error.code??"RESEARCH_PREPARATION_FAILED",finishedAt:new Date().toISOString()});
      if(error instanceof ResearchFailure)throw error;
      fail(error.code??"RESEARCH_PREPARATION_FAILED",error.message||"研究准备失败");
    }
    return {status:202,value:{accepted:true,duplicate:false,...researchView(task)}};
  }
  async run(task,context) {
    const r=task.research,skill=this.skill(),path=r.nativeSkill?.path;
    if(!path||skill.packageSha256!==r.skillPackageSha256||sha256(readFileSync(path))!==r.skillSha256)
      fail("SKILL_VERSION_MISMATCH","执行前Skill包变化，未执行",409);
    const discovered=await this.client.request("skills/list",{cwds:[task.cwd],forceReload:true});
    if(!discovered.data?.some(d=>samePath(d.cwd,task.cwd)&&d.skills?.some(s=>s.name===r.skillName&&samePath(s.path,path)&&s.enabled===true)))
      fail("NATIVE_SKILL_NOT_DISCOVERED","Codex没有发现这项专业研究技能，研究没有开始。");
    let native=null; const searches=[];
    const result=await this.runner.run(task,{...context,emit:(type,data)=>{
      if(type==="research.native-skill")native=data;
      if(type==="codex"&&data.type==="item.completed"&&data.item?.type==="webSearch"&&data.item.status!=="failed")
        searches.push({id:data.item.id,action:data.item.action??null});
      context.emit(type,data);
    }});
    if(!native?.accepted||native.name!==r.skillName||native.sha256!==r.skillSha256||!native.turnId)
      fail("NATIVE_EXECUTION_VERIFICATION_REQUIRED","缺少本任务原生Skill输入受理证据",409);
    if(!searches.length)fail("RESEARCH_RETRIEVAL_NOT_VERIFIED","未记录真实检索工具执行，不能标记研究成功",409);
    let value;
    try{value=JSON.parse(result.finalResponse);}catch{fail("RESEARCH_DELIVERY_INVALID","研究结束但双文件封装不是完整JSON",422);}
    if(Object.keys(value??{}).sort().join(",")!=="jsonText,markdown"||typeof value.jsonText!=="string")
      fail("RESEARCH_PAIR_INCOMPLETE","研究缺少完整MD或JSON原件",422);
    const snapshot=JSON.parse(value.jsonText);
    if(!snapshot.rows?.length)fail("RESEARCH_EMPTY_RESULT","空研究成果不能标记成功",422);
    if(this.skill().packageSha256!==r.skillPackageSha256||sha256(readFileSync(path))!==r.skillSha256)
      fail("SKILL_VERSION_MISMATCH","执行期间Skill包变化，未发布成果",409);
    finishResearchFiles(this.config,task,value.markdown,value.jsonText,result.finalResponse);
    task.research.nativeEvidence={...native,searches,verified:true};
    task.research.phase="completed";
    return {...result,files:[join(dirname(this.config.stateFile),"research",task.id,"v"+r.version,"research.md"),
      join(dirname(this.config.stateFile),"research",task.id,"v"+r.version,"research.json")]};
  }
}
