figma.showUI(__html__, {
  width: 560,
  height: 680,
  title: "Figment AI"
});

function serializeNode(node, depth) {
  if (depth > 4) return { id: node.id, name: node.name, type: node.type };
  const base = {
    id: node.id, name: node.name, type: node.type,
    width: Math.round('width' in node ? node.width : 0),
    height: Math.round('height' in node ? node.height : 0),
  };
  if ('fills' in node && Array.isArray(node.fills) && node.fills.length > 0) {
    const fill = node.fills[0];
    if (fill.type === 'SOLID') base.fillColor = fill.color;
  }
  if ('characters' in node) {
    base.text = node.characters.slice(0, 120);
    if ('fontSize' in node) base.fontSize = node.fontSize;
  }
  if ('mainComponent' in node && node.mainComponent) base.componentName = node.mainComponent.name;
  if ('children' in node && node.children.length > 0) {
    base.childCount = node.children.length;
    base.children = node.children.slice(0, 20).map(c => serializeNode(c, depth + 1));
  }
  if ('layoutMode' in node) base.layoutMode = node.layoutMode;
  if ('itemSpacing' in node) base.gap = node.itemSpacing;
  return base;
}

const initSel = figma.currentPage.selection;
if (initSel.length === 1) {
  figma.ui.postMessage({ type: 'selection', node: { id: initSel[0].id, name: initSel[0].name, type: initSel[0].type } });
} else {
  figma.ui.postMessage({ type: 'selection', node: null });
}

figma.on('selectionchange', () => {
  const sel = figma.currentPage.selection;
  if (sel.length === 1) {
    figma.ui.postMessage({ type: 'selection', node: { id: sel[0].id, name: sel[0].name, type: sel[0].type } });
  } else {
    figma.ui.postMessage({ type: 'selection', node: null });
  }
});

figma.ui.onmessage = async (msg) => {

  if (msg.type === 'resize') {
    figma.ui.resize(msg.width || 560, msg.height || 680);
    return;
  }

  if (msg.type === 'analyze') {
    const sel = figma.currentPage.selection;
    if (sel.length !== 1) { figma.ui.postMessage({ type: 'error', text: 'Выдели один фрейм или компонент' }); return; }
    figma.ui.postMessage({ type: 'frame-data', data: serializeNode(sel[0], 0) });
  }

  if (msg.type === 'ai-normalize') {
    const sel = figma.currentPage.selection;
    if (!sel.length) { figma.ui.postMessage({ type: 'action-error', text: 'Выдели фрейм' }); return; }
    let stats = { fonts: 0, layouts: 0 };
    const FAMILY = msg.fontFamily || 'Inter';
    const styleMap = { 'Thin':'Regular','Light':'Regular','Regular':'Regular','Medium':'Medium','SemiBold':'Medium','Semi Bold':'Medium','Bold':'Bold','ExtraBold':'Bold','Extra Bold':'Bold','Black':'Bold','Italic':'Regular','Medium Italic':'Medium','Bold Italic':'Bold' };
    try {
      await Promise.all([figma.loadFontAsync({family:FAMILY,style:'Regular'}),figma.loadFontAsync({family:FAMILY,style:'Medium'}),figma.loadFontAsync({family:FAMILY,style:'Bold'})]);
    } catch(e) { figma.ui.postMessage({ type: 'action-error', text: 'Не удалось загрузить шрифт ' + FAMILY }); return; }
    const textNodes = [];
    function collectText(node) { if (node.type === 'TEXT') textNodes.push(node); if ('children' in node) node.children.forEach(collectText); }
    sel.forEach(collectText);
    const limit = Math.min(textNodes.length, 200);
    if (textNodes.length > 200) figma.notify('Много слоёв — обрабатываю первые 200', { timeout: 3000 });
    for (let i = 0; i < limit; i++) {
      const node = textNodes[i];
      try { if (node.fontName !== figma.mixed) { node.fontName = { family: FAMILY, style: styleMap[node.fontName.style] || 'Regular' }; node.letterSpacing = { value: 0, unit: 'PERCENT' }; node.lineHeight = { unit: 'AUTO' }; stats.fonts++; } } catch(e) {}
      if (i % 30 === 0) { figma.ui.postMessage({ type: 'progress', text: 'Шрифты: ' + i + '/' + limit }); figma.notify('Нормализация... ' + i + '/' + limit, { timeout: 500 }); }
    }
    figma.notify('✅ Готово!', { timeout: 2000 });
    figma.ui.postMessage({ type: 'action-done', text: 'AI нормализация: ' + stats.fonts + ' текстов, ' + stats.layouts + ' лейаутов' });
  }

  if (msg.type === 'smart-autolayout-prepare') {
    const sel = figma.currentPage.selection;
    if (!sel.length) { figma.ui.postMessage({ type: 'action-error', text: 'Выдели фрейм' }); return; }
    const node = sel[0];
    let imageData = null;
    try { const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 0.5 } }); imageData = figma.base64Encode(bytes); }
    catch(e) { figma.ui.postMessage({ type: 'action-error', text: 'Не удалось сделать скриншот: ' + e.message }); return; }
    function buildLeanTree(node, depth) {
      if (depth > 4) return null;
      if ('visible' in node && node.visible === false) return null;
      if ('opacity' in node && node.opacity === 0) return null;
      const item = { id:node.id,name:node.name,type:node.type,x:Math.round('x' in node?node.x:0),y:Math.round('y' in node?node.y:0),w:Math.round('width' in node?node.width:0),h:Math.round('height' in node?node.height:0),isInstance:node.type==='INSTANCE',hasChildren:'children' in node&&node.children.length>0,layoutMode:'layoutMode' in node?node.layoutMode:null,constraints:'constraints' in node?node.constraints:null };
      if ('characters' in node && node.characters) item.text = node.characters.slice(0, 40);
      if (node.type==='INSTANCE'||node.type==='VECTOR'||node.type==='BOOLEAN_OPERATION') return item;
      if ('children' in node && node.children.length > 0) item.children = node.children.map(c => buildLeanTree(c, depth+1)).filter(Boolean);
      return item;
    }
    figma.commitUndo();
    figma.ui.postMessage({ type: 'smart-autolayout-data', image: imageData, tree: buildLeanTree(node, 0), frameId: node.id, frameName: node.name });
  }

  if (msg.type === 'smart-autolayout-apply') {
    const plan = msg.plan; let applied = 0, errors = [];
    function applyContainer(container) {
      if (container.children && container.children.length > 0) container.children.forEach(applyContainer);
      if (!container.nodeIds || container.nodeIds.length < 2) return;
      try {
        const nodes = container.nodeIds.map(id => figma.getNodeById(id)).filter(Boolean);
        if (nodes.length < 2) return;
        const parent = nodes[0].parent;
        if (!parent || !nodes.every(n => n.parent && n.parent.id === parent.id)) return;
        const newFrame = figma.createFrame();
        newFrame.name = container.name || container.label || 'auto-layout';
        let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
        nodes.forEach(n => { const b=n.absoluteBoundingBox||{x:n.x,y:n.y,width:n.width,height:n.height}; minX=Math.min(minX,b.x);minY=Math.min(minY,b.y);maxX=Math.max(maxX,b.x+b.width);maxY=Math.max(maxY,b.y+b.height); });
        const insertIndex = parent.children.indexOf(nodes[0]);
        parent.insertChild(insertIndex, newFrame);
        const pb = parent.absoluteBoundingBox||{x:0,y:0};
        newFrame.x=minX-pb.x;newFrame.y=minY-pb.y;newFrame.resize(maxX-minX,maxY-minY);
        newFrame.fills=[];newFrame.clipsContent=false;
        newFrame.layoutMode=container.direction||'HORIZONTAL';newFrame.itemSpacing=container.gap||0;
        newFrame.paddingTop=container.paddingTop||0;newFrame.paddingBottom=container.paddingBottom||0;
        newFrame.paddingLeft=container.paddingLeft||0;newFrame.paddingRight=container.paddingRight||0;
        newFrame.primaryAxisAlignItems=container.primaryAxisAlignItems||'MIN';newFrame.counterAxisAlignItems=container.counterAxisAlignItems||'MIN';
        newFrame.primaryAxisSizingMode=container.primaryAxisSizingMode||'AUTO';newFrame.counterAxisSizingMode=container.counterAxisSizingMode||'AUTO';
        nodes.forEach(n => newFrame.appendChild(n));
        applied++;figma.ui.postMessage({type:'progress',text:'Контейнеры: '+applied});
      } catch(e) { errors.push((container.name||container.label)+': '+e.message); }
    }
    if (plan.containers) plan.containers.forEach(applyContainer);
    let renamed = 0;
    if (plan.renames) Object.keys(plan.renames).forEach(function(nodeId) { try { const node=figma.getNodeById(nodeId); if(node){node.name=plan.renames[nodeId];renamed++;} } catch(e){} });
    figma.notify('✅ Готово!', { timeout: 2000 });
    figma.ui.postMessage({ type: 'action-done', text: 'Умный лейаут: '+applied+' контейнеров, '+renamed+' переименовано'+(errors.length?'. Ошибки: '+errors.slice(0,2).join(', '):'') });
  }

  if (msg.type === 'ai-rename-prepare') {
    const sel = figma.currentPage.selection;
    if (!sel.length) { figma.ui.postMessage({ type: 'action-error', text: 'Выдели фрейм' }); return; }
    const typeMap = {'FRAME':'frame','GROUP':'group','COMPONENT':'component','INSTANCE':'instance','TEXT':'text','RECTANGLE':'rect','ELLIPSE':'ellipse','VECTOR':'vector','LINE':'line','BOOLEAN_OPERATION':'bool','IMAGE':'image','SECTION':'section'};
    function collectTree(node, depth) {
      if (depth > 3) return null;
      const item = { id:node.id, t:typeMap[node.type]||node.type.toLowerCase(), n:node.name };
      if ('characters' in node && node.characters) item.tx = node.characters.slice(0, 40);
      if ('children' in node && node.children.length) item.ch = node.children.slice(0, 20).map(c => collectTree(c, depth+1)).filter(Boolean);
      return item;
    }
    figma.ui.postMessage({ type: 'ai-rename-tree', tree: collectTree(sel[0], 0) });
  }

  if (msg.type === 'ai-rename-apply') {
    const map = msg.map; let count = 0;
    function applyRename(node) { if(map[node.id]){node.name=map[node.id];count++;} if('children' in node)node.children.forEach(applyRename); }
    figma.currentPage.selection.forEach(applyRename);
    figma.ui.postMessage({ type: 'action-done', text: 'AI переименовал ' + count + ' слоёв' });
  }

  if (msg.type === 'apply-autolayout') {
    const sel = figma.currentPage.selection;
    if (!sel.length) { figma.ui.postMessage({ type: 'action-error', text: 'Выдели фрейм' }); return; }
    let count = 0;
    function applyLayout(node) {
      if ((node.type==='FRAME'||node.type==='COMPONENT')&&node.layoutMode==='NONE'&&'children' in node&&node.children.length>1) {
        const children=node.children;let isH=true;
        for(let i=1;i<children.length;i++){if('y' in children[i]&&Math.abs(children[i].y-children[i-1].y)>Math.abs(children[i].x-children[i-1].x)){isH=false;break;}}
        node.layoutMode=isH?'HORIZONTAL':'VERTICAL';node.primaryAxisSizingMode='AUTO';node.counterAxisSizingMode='AUTO';
        node.itemSpacing=8;node.paddingTop=node.paddingBottom=node.paddingLeft=node.paddingRight=0;
        count++;figma.notify('Авто-лейаут: '+count+' фреймов...', {timeout:600});
      }
      if ('children' in node) node.children.forEach(applyLayout);
    }
    sel.forEach(applyLayout);
    figma.notify('✅ Авто-лейаут готов!', { timeout: 2000 });
    figma.ui.postMessage({ type: 'action-done', text: 'Авто-лейаут применён к ' + count + ' фреймам' });
  }

  if (msg.type === 'use-selected-frame') {
    const sel = figma.currentPage.selection;
    if (sel.length === 1) figma.ui.postMessage({ type: 'selected-frame-for-action', node: { id: sel[0].id, name: sel[0].name } });
    else figma.ui.postMessage({ type: 'error', text: 'Ничего не выделено' });
  }

  if (msg.type === 'extract-components-prepare') {
    const sel = figma.currentPage.selection;
    if (!sel.length) { figma.ui.postMessage({ type: 'action-error', text: 'Выдели фрейм' }); return; }
    const node = sel[0];
    const typeMap = {'FRAME':'frame','GROUP':'group','COMPONENT':'component','INSTANCE':'instance','TEXT':'text','RECTANGLE':'rect','ELLIPSE':'ellipse','VECTOR':'vector','LINE':'line'};
    function buildTree(n, depth) {
      if (depth > 4) return null;
      const item = {id:n.id,name:n.name,type:typeMap[n.type]||n.type.toLowerCase(),w:Math.round('width' in n?n.width:0),h:Math.round('height' in n?n.height:0),isInstance:n.type==='INSTANCE',componentName:n.type==='INSTANCE'&&n.mainComponent?n.mainComponent.name:null};
      if ('characters' in n && n.characters) item.text = n.characters.slice(0, 40);
      if ('children' in n && n.children.length && n.type !== 'INSTANCE') item.children = n.children.slice(0, 20).map(c => buildTree(c, depth+1)).filter(Boolean);
      return item;
    }
    figma.ui.postMessage({ type: 'extract-components-tree', tree: buildTree(node, 0), frameName: node.name });
  }

  if (msg.type === 'extract-components-apply') {
    const components = msg.components;
    if (!components || !components.length) { figma.ui.postMessage({ type: 'action-error', text: 'Нет компонентов для извлечения' }); return; }
    figma.commitUndo();
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
    const container = figma.createFrame();
    container.name='Extracted Components';container.layoutMode='VERTICAL';container.primaryAxisSizingMode='AUTO';container.counterAxisSizingMode='AUTO';
    container.itemSpacing=40;container.paddingTop=container.paddingBottom=container.paddingLeft=container.paddingRight=32;
    container.fills=[{type:'SOLID',color:{r:0.97,g:0.97,b:0.98}}];container.cornerRadius=16;
    const sel = figma.currentPage.selection;
    if (sel.length) { container.x=sel[0].x+sel[0].width+80;container.y=sel[0].y; }
    figma.currentPage.appendChild(container);
    for (const comp of components) {
      const group=figma.createFrame();group.name=comp.label;group.layoutMode='VERTICAL';group.primaryAxisSizingMode='AUTO';group.counterAxisSizingMode='AUTO';group.itemSpacing=12;group.fills=[];
      container.appendChild(group);
      const label=figma.createText();label.characters=comp.label;label.fontSize=14;label.fontName={family:'Inter',style:'Medium'};label.fills=[{type:'SOLID',color:{r:0.12,g:0.18,b:0.24}}];
      group.appendChild(label);
      const statesRow=figma.createFrame();statesRow.name=comp.label+'__states';statesRow.layoutMode='HORIZONTAL';statesRow.primaryAxisSizingMode='AUTO';statesRow.counterAxisSizingMode='AUTO';statesRow.itemSpacing=16;statesRow.fills=[];
      group.appendChild(statesRow);
      const sourceNode=figma.getNodeById(comp.nodeId);
      for (const state of comp.states) {
        const stateWrap=figma.createFrame();stateWrap.name='State='+state;stateWrap.layoutMode='VERTICAL';stateWrap.primaryAxisSizingMode='AUTO';stateWrap.counterAxisSizingMode='AUTO';stateWrap.itemSpacing=8;stateWrap.fills=[];
        statesRow.appendChild(stateWrap);
        const stateLabel=figma.createText();stateLabel.characters=state;stateLabel.fontSize=11;stateLabel.fontName={family:'Inter',style:'Regular'};stateLabel.fills=[{type:'SOLID',color:{r:0.49,g:0.54,b:0.58}}];
        stateWrap.appendChild(stateLabel);
        if (sourceNode) {
          try{const copy=sourceNode.clone();copy.name=comp.type+'/'+state;stateWrap.appendChild(copy);}
          catch(e){const ph=figma.createFrame();ph.name=comp.type+'/'+state;ph.resize(sourceNode.width||80,sourceNode.height||40);ph.fills=[{type:'SOLID',color:{r:0.9,g:0.92,b:0.95}}];ph.cornerRadius=8;stateWrap.appendChild(ph);}
        }
      }
    }
    figma.viewport.scrollAndZoomIntoView([container]);
    figma.ui.postMessage({ type: 'action-done', text: 'Извлечено ' + components.length + ' компонентов со стейтами' });
  }

  if (msg.type === 'save-memory') { await figma.clientStorage.setAsync('figment_memory', msg.memory); }
  if (msg.type === 'load-memory') { const mem = await figma.clientStorage.getAsync('figment_memory'); figma.ui.postMessage({ type: 'memory-loaded', memory: mem || {} }); }
  if (msg.type === 'notify') { figma.notify(msg.text); }
};
