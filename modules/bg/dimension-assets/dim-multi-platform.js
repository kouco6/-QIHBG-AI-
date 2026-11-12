(() => {
  'use strict';
  const ids = ['DIM-05','DIM-06','DIM-07','DIM-08','DIM-09','DIM-10','DIM-11','DIM-12'];
  const dimNumber = () => ui.dimId.slice(-2);
  const currentStore = () => data.showcases?.[ui.projectId]?.[ui.dimId] || null;
  const clone = value => JSON.parse(JSON.stringify(value));
  window.dimMultiVersions = () => currentStore()?.versions || (ui.dimMultiSeed ? [{id:'seed',createdAt:null,label:'原始示例',snapshot:ui.dimMultiSeed}] : []);
  window.dimMultiSummary = snapshot => {
    if(ui.dimId==='DIM-05')return `${snapshot.inventory.length} 个功能模块 / ${snapshot.inventory.reduce((n,m)=>n+m.features.length,0)} 项功能 / ${snapshot.highlight_features.length} 项亮点`;
    if(ui.dimId==='DIM-06')return `${snapshot.rows.length} 条性能指标 / 8 个字段`;
    if(ui.dimId==='DIM-07')return `${snapshot.rows.length} 条 AI 功能规划 / ${snapshot.fields.length} 个字段`;
    if(ui.dimId==='DIM-08')return `${snapshot.competitors.length} 款竞品 / ${snapshot.bom.length} 项 BOM`;
    if(ui.dimId==='DIM-09')return `${snapshot.topics.reduce((n,t)=>n+Object.values(t.clauses).reduce((m,rows)=>m+rows.length,0),0)} 条原始参数 / ${snapshot.points.length} 个控标点`;
    if(ui.dimId==='DIM-11')return `${snapshot.products.length} 款竞品 / 每款 4 项设计信息`;
    if(ui.dimId==='DIM-12')return `${snapshot.fields.length} 项运维指标 / ${snapshot.values.filter((value,index)=>index!==15&&value==='pending').length} 项待选择`;
    return `${snapshot.original.length} 条原始参数 / ${snapshot.topics.length} 个主题`;
  };
  const legacyPerformance = selected => ui.dimId==='DIM-06'&&selected&&selected.snapshot.format!=='v5';
  window.dimMultiWorkspacePage = () => {
    const mode=ui.dimView||'content',number=dimNumber(),name=dim(ui.dimId).name;
    const sections=number==='05'?[['page01','01 产品功能架构'],['page02','02 完整功能清单'],['page03','03 核心功能与亮点'],['page04','04 竞品功能对标']]:number==='06'?[['table','01 性能指标总表']]:number==='09'?[['raw','01 原始招标参数'],['points','02 控标点']]:number==='10'?[['integrated','01 参数整合'],['original','02 原始参数']]:[];
    const selected=ui.dim01PreviewVersion?window.dimMultiVersions().find(v=>v.id===ui.dim01PreviewVersion):null;
    const core=number==='06'?(legacyPerformance(selected)?'dim-multi-core.html':'dim06-core.html'):Number(number)>=11?'dim-final-core.html':Number(number)>=8?'dim-bid-core.html':'dim-multi-core.html';
    const inner=mode==='process'?`<div class="dim01-research">${researchPage()}</div>`:`<iframe id="dim-multi-core-frame" class="dim01-frame" title="${esc(name)}·${mode==='content'?'内容展示':'文字纯享版'}" src="/dimension-assets/${core}?dim=${number}&view=${mode}"></iframe>`;
    return dimensionWorkspace(inner,sections);
  };
  function sendState(saved=false){const frame=document.getElementById('dim-multi-core-frame');if(!frame?.contentWindow)return;const selected=ui.dim01PreviewVersion?window.dimMultiVersions().find(v=>v.id===ui.dim01PreviewVersion):null;frame.contentWindow.postMessage(ui.dimId==='DIM-06'&&!legacyPerformance(selected)?{type:'bg-dim06-state',content:selected?.snapshot||(ui.dim01WorkMode&&!selected&&ui.dimView==='content'?currentStore()?.draft:null)||currentStore()?.current||ui.dimMultiSeed,workMode:ui.dim01WorkMode&&!selected&&ui.dimView==='content',preview:!!selected}:{type:'bg-showcase-state',dim:dimNumber(),content:selected?.snapshot||(ui.dim01WorkMode&&!selected&&ui.dimView==='content'?currentStore()?.draft:null)||currentStore()?.current||ui.dimMultiSeed,workMode:ui.dim01WorkMode&&!selected&&ui.dimView==='content',preview:!!selected,saved},location.origin)}
  let saving=false;
  const mutableFields={
    'DIM-05':{feature:new Set(['feature_name']),product:new Set(['ability_state','delivery_state','display_label','source_state','detail','raw_research_statement']),highlight:new Set(['title','category','product_scope','behavior','value','boundary']),comparison:new Set(['feature','legacy','pro','comparison'])},
    'DIM-06':new Set(['title','point','category','functional','design','test','competitor','experience']),
    'DIM-07':new Set(['AI功能名称','业务场景','AI功能应用','解决用户痛点','预期效果','可行性']),
    'DIM-10':new Set(['req','s'])
  };
  function allowedPatch(path){
    if(!Array.isArray(path)||path.some(x=>typeof x!=='string'&&!(Number.isInteger(x)&&x>=0)))return false;
    if(ui.dimId==='DIM-05'){
      if(path.length===2&&path[0]==='scope'&&path[1]==='external_competitor')return true;
      if(path.length===2&&path[0]==='stats'&&path[1]==='caveat')return true;
      if(path.length===5&&path[0]==='inventory'&&path[2]==='features')return mutableFields['DIM-05'].feature.has(path[4]);
      if(path.length===7&&path[0]==='inventory'&&path[2]==='features'&&path[4]==='products'&&['legacy','pro','a24'].includes(path[5]))return mutableFields['DIM-05'].product.has(path[6]);
      if(path.length===3&&path[0]==='highlight_features')return mutableFields['DIM-05'].highlight.has(path[2]);
      if(path.length===3&&path[0]==='comparisons')return mutableFields['DIM-05'].comparison.has(path[2]);
      return false;
    }
    if(ui.dimId==='DIM-08')return path.length===1&&['product','ownCost'].includes(path[0])||path.length===3&&path[0]==='competitors'&&Number.isInteger(path[1])&&['name','model','price','source','url'].includes(path[2])||path.length===3&&path[0]==='bom'&&Number.isInteger(path[1])&&['name','count','unit'].includes(path[2]);
    if(ui.dimId==='DIM-09')return path.length===6&&path[0]==='topics'&&Number.isInteger(path[1])&&path[2]==='clauses'&&['甲','乙','丙'].includes(path[3])&&Number.isInteger(path[4])&&[1,2].includes(path[5])||path.length===3&&path[0]==='points'&&Number.isInteger(path[1])&&['title','require','contrast','why','type'].includes(path[2]);
    if(ui.dimId==='DIM-10')return path.length===3&&path[0]==='original'&&Number.isInteger(path[1])&&mutableFields['DIM-10'].has(path[2])||path.length===3&&path[0]==='topics'&&Number.isInteger(path[1])&&path[2]==='name';
    if(ui.dimId==='DIM-11')return path.length===3&&path[0]==='products'&&Number.isInteger(path[1])&&['name','model','kind','imageUrl'].includes(path[2])||path.length===5&&path[0]==='products'&&Number.isInteger(path[1])&&path[2]==='fields'&&Number.isInteger(path[3])&&path[4]==='value';
    if(ui.dimId==='DIM-12')return path.length===1&&path[0]==='product'||path.length===2&&path[0]==='values'&&Number.isInteger(path[1]);
    return path.length===3&&path[0]==='rows'&&Number.isInteger(path[1])&&mutableFields[ui.dimId]?.has(path[2]);
  }
  async function savePatches(message){
    const frame=document.getElementById('dim-multi-core-frame');
    const fail=error=>frame?.contentWindow?.postMessage({type:'bg-showcase-save-error',dim:dimNumber(),error},location.origin);
    if(saving||!ui.dim01WorkMode||ui.dim01PreviewVersion||!ui.dimMultiSeed||storageError){fail('当前不能编辑，请确认已进入工作模式。');return}
    if(!Array.isArray(message.patches)||!message.patches.length||message.patches.length>24){fail('编辑字段不完整。');return}
    const before=currentStore(),next=clone(before?.draft||before?.current||ui.dimMultiSeed);
    let changed=false;
    for(const patch of message.patches){
      const maxLength=ui.dimId==='DIM-11'&&patch.path.at(-1)==='imageUrl'?800000:5000;
      const optionalWhileEditing=ui.dimId==='DIM-12'&&patch.path[0]==='values'&&patch.path[1]===15;
      if(!allowedPatch(patch.path)||typeof patch.value!=='string'||(!optionalWhileEditing&&!patch.value.trim())||patch.value.length>maxLength){fail('字段不符合固定架构，请重新编辑。');return}
      const parent=patch.path.slice(0,-1).reduce((value,key)=>value?.[key],next),key=patch.path.at(-1);
      if(!parent||!['string','number'].includes(typeof parent[key])){fail('未找到对应字段，请重新打开编辑。');return}
      let value=patch.value;
      if(typeof parent[key]==='number'){
        value=Number(value);
        if(!Number.isFinite(value)||value<0||value>1e9||(key==='count'&&!Number.isInteger(value))){fail('金额或数量格式不正确。');return}
      }
      if(key==='url'&&!/^https?:\/\//i.test(value)){fail('报价依据须为 http 或 https 链接。');return}
      if(ui.dimId==='DIM-11'&&key==='imageUrl'&&!(value==='sample'||/^https?:\/\//i.test(value)&&value.length<=2000||/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value))){fail('图片须选择本机图片或填写 http(s) 链接。');return}
      if(ui.dimId==='DIM-12'&&patch.path[0]==='values'&&patch.path[1]!==15&&!['yes','no','pending'].includes(value)){fail('规划状态不在允许选项中。');return}
      if(ui.dimId==='DIM-09'&&key==='type'&&!['性能','功能','架构','接口'].includes(value)){fail('控标类型不在允许选项中。');return}
      if(ui.dimId==='DIM-09'&&key===2&&!['完全满足','特做满足：低成本/短周期','特做满足：高成本/长周期','无法','待核实'].includes(value)){fail('条款状态不在允许选项中。');return}
      if(ui.dimId==='DIM-10'&&key==='s'&&!['full','low','high','none'].includes(value)){fail('应标状态不在允许选项中。');return}
      if(parent[key]!==value){parent[key]=value;changed=true}
    }
    if(!changed){sendState(true);return}
    data.showcases??={};data.showcases[ui.projectId]??={};
    const versions=before?.versions?clone(before.versions):[{id:uid('show'),createdAt:now(),label:'原始示例',snapshot:clone(ui.dimMultiSeed)}];
    ui.restoreUndo=null;data.showcases[ui.projectId][ui.dimId]={...before,current:before?.current||clone(ui.dimMultiSeed),versions,draft:next,applied:before?.applied??Boolean(before),autoDirty:true};
    const project=P(ui.projectId);if(project)project.updatedAt=now();
    saving=true;const ok=await persistWorkspace();saving=false;
    if(!ok){fail('本机保存失败，请重试。');return}
    sendState(true);
  }
  async function saveDim06Full(snapshot){
    if(!ui.dim01WorkMode||ui.dim01PreviewVersion||!snapshot||snapshot.format!=='v5'||!Array.isArray(snapshot.rows))return;
    const before=currentStore();if(JSON.stringify(before?.draft||before?.current)===JSON.stringify(snapshot))return;
    data.showcases??={};data.showcases[ui.projectId]??={};
    const versions=before?.versions?clone(before.versions):[{id:uid('show'),createdAt:now(),label:'原始示例',snapshot:clone(ui.dimMultiSeed)}];
    ui.restoreUndo=null;data.showcases[ui.projectId][ui.dimId]={...before,current:before?.current||clone(ui.dimMultiSeed),versions,draft:clone(snapshot),applied:before?.applied??Boolean(before),autoDirty:true};
    if(!await persistWorkspace())return
    const status=document.querySelector('.workspace-save-state');if(status)status.textContent='已自动暂存';
  }
  window.restoreDimMultiVersion=async id=>{
    const target=window.dimMultiVersions().find(v=>v.id===id),before=currentStore();if(!target)return;
    data.showcases??={};data.showcases[ui.projectId]??={};
    const versions=before?.versions?clone(before.versions):[{id:uid('show'),createdAt:now(),label:'原始示例',snapshot:clone(ui.dimMultiSeed)}];
    const next=clone(target.snapshot);versions.push({id:uid('show'),createdAt:now(),label:'恢复历史版本',snapshot:clone(next)});
    data.showcases[ui.projectId][ui.dimId]={current:next,versions};
    const project=P(ui.projectId),oldTime=project?.updatedAt;if(project)project.updatedAt=now();
    const ok=await persist();if(!ok){if(project)project.updatedAt=oldTime;if(before)data.showcases[ui.projectId][ui.dimId]=before;else delete data.showcases[ui.projectId][ui.dimId];return}
    ui.dim01PreviewVersion=null;ui.drawer=null;closeModal();render();toast('已恢复历史内容，原版本保留');
  };
  window.handleMultiAction=(act,el)=>{
    if(!ids.includes(ui.dimId)||ui.page!=='workspace')return false;
    if(act==='dim-multi-history'){openDrawer('showcase-history');return true}
    if(act==='dim-multi-current'){ui.dim01PreviewVersion=null;render();return true}
    if(act==='dim-multi-work-enter'){ui.dim01WorkMode=true;ui.dimView='content';render();return true}
    if(act==='dim-multi-work-exit'){ui.dim01WorkMode=false;render();return true}
    if(act==='dim01-section'){ui.dim01Section=el.dataset.section;document.querySelectorAll('.dim01-modules button').forEach(button=>button.classList.toggle('active',button.dataset.section===ui.dim01Section));document.getElementById('dim-multi-core-frame')?.contentWindow?.postMessage({type:'bg-showcase-section',dim:dimNumber(),id:ui.dim01Section},location.origin);return true}
    return false;
  };
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||event.source!==document.getElementById('dim-multi-core-frame')?.contentWindow)return;
    const msg=event.data;
    if(ui.dimId==='DIM-06'&&msg?.type==='bg-dim06-ready'){if(!ui.dimMultiSeed)ui.dimMultiSeed=msg.seed;sendState();return}
    if(ui.dimId==='DIM-06'&&msg?.type==='bg-dim06-save-full'){saveDim06Full(msg.snapshot);return}
    if(ui.dimId==='DIM-06'&&msg?.type==='bg-dim06-save-draft'){workspaceSaveDraft();return}
    if(ui.dimId==='DIM-06'&&msg?.type==='bg-dim06-apply'){workspaceApplySnapshot('DIM-06',msg.snapshot);return}
    if(!msg||msg.dim!==dimNumber())return;
    if(ui.dimId==='DIM-12'&&msg.type==='bg-dim12-apply'){workspaceApplySnapshot('DIM-12');return}
    if(ui.dimId==='DIM-12'&&msg.type==='bg-dim12-save-draft'){workspaceSaveDraft();return}
    if(msg.type==='bg-showcase-ready'){if(!ui.dimMultiSeed)ui.dimMultiSeed=msg.seed;sendState();return}
    if(msg.type==='bg-showcase-save'){savePatches(msg);return}
    if(msg.type==='bg-showcase-active'){ui.dim01Section=msg.id;document.querySelectorAll('.dim01-modules button').forEach(button=>button.classList.toggle('active',button.dataset.section===ui.dim01Section))}
  });
})();
