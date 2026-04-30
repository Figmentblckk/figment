figma.showUI(__html__, {
  width: 420,
  height: 680,
  title: "Figment AI"
});

function serializeNode(node, depth) {
  if (depth > 4) return { id: node.id, name: node.name, type: node.type };

  const base = {
    id: node.id,
    name: node.name,
    type: node.type,
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

  if ('mainComponent' in node && node.mainComponent) {
    base.componentName = node.mainComponent.name;
  }

  if ('children' in node && node.children.length > 0) {
    base.childCount = node.children.length;
    base.children = node.children.slice(0, 20).map(c => serializeNode(c, depth + 1));
  }

  if ('layoutMode' in node) base.layoutMode = node.layoutMode;
  if ('itemSpacing' in node) base.gap = node.itemSpacing;

  return base;
}

// Send initial selection on startup
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

  if (msg.type === 'analyze') {
    const sel = figma.currentPage.selection;
    if (sel.length !== 1) {
      figma.ui.postMessage({ type: 'error', text: 'Выдели один фрейм или компонент' });
      return;
    }
    const serialized = serializeNode(sel[0], 0);
    figma.ui.postMessage({ type: 'frame-data', data: serialized });
  }

  if (msg.type === 'apply-autolayout') {
    const sel = figma.currentPage.selection;
    if (!sel.length) {
      figma.ui.postMessage({ type: 'action-error', text: 'Выдели фрейм' });
      return;
    }
    let count = 0;

    function applyLayout(node) {
      if (node.type === 'FRAME' || node.type === 'COMPONENT') {
        if (node.layoutMode === 'NONE' && 'children' in node && node.children.length > 1) {
          const children = node.children;
          let isHorizontal = true;
          for (let i = 1; i < children.length; i++) {
            if ('y' in children[i] && 'y' in children[i-1]) {
              if (Math.abs(children[i].y - children[i-1].y) > Math.abs(children[i].x - children[i-1].x)) {
                isHorizontal = false;
                break;
              }
            }
          }
          node.layoutMode = isHorizontal ? 'HORIZONTAL' : 'VERTICAL';
          node.primaryAxisSizingMode = 'AUTO';
          node.counterAxisSizingMode = 'AUTO';
          node.itemSpacing = 8;
          node.paddingTop = node.paddingBottom = node.paddingLeft = node.paddingRight = 0;
          count++;
          figma.notify('Авто-лейаут: ' + count + ' фреймов...', { timeout: 600 });
        }
      }
      if ('children' in node) node.children.forEach(applyLayout);
    }

    sel.forEach(applyLayout);
    figma.notify('✅ Авто-лейаут готов!', { timeout: 2000 });
    figma.ui.postMessage({ type: 'action-done', text: 'Авто-лейаут применён к ' + count + ' фреймам' });
  }

  if (msg.type === 'ai-normalize') {
    const sel = figma.currentPage.selection;
    if (!sel.length) {
      figma.ui.postMessage({ type: 'action-error', text: 'Выдели фрейм' });
      return;
    }

    let stats = { fonts: 0, layouts: 0 };

    // Step 1: Load fonts
    const FAMILY = msg.fontFamily || 'Inter';
    const styleMap = {
      'Thin':'Regular','Light':'Regular','Regular':'Regular',
      'Medium':'Medium','SemiBold':'Medium','Semi Bold':'Medium',
      'Bold':'Bold','ExtraBold':'Bold','Extra Bold':'Bold','Black':'Bold',
      'Italic':'Regular','Medium Italic':'Medium','Bold Italic':'Bold'
    };

    try {
      await Promise.all([
        figma.loadFontAsync({ family: FAMILY, style: 'Regular' }),
        figma.loadFontAsync({ family: FAMILY, style: 'Medium' }),
        figma.loadFontAsync({ family: FAMILY, style: 'Bold' })
      ]);
    } catch(e) {
      figma.ui.postMessage({ type: 'action-error', text: 'Не удалось загрузить шрифт ' + FAMILY });
      return;
    }

    // Count total nodes first
    let total = 0;
    function countNodes(node) {
      total++;
      if ('children' in node) node.children.forEach(countNodes);
    }
    sel.forEach(countNodes);

    let processed = 0;
    // Collect all text nodes first
    const textNodes = [];
    function collectText(node) {
      if (node.type === 'TEXT') textNodes.push(node);
      if ('children' in node) node.children.forEach(collectText);
    }
    sel.forEach(collectText);

    const limit = Math.min(textNodes.length, 200);
    if (textNodes.length > 200) {
      figma.notify('Много слоёв — обрабатываю первые 200', { timeout: 3000 });
    }

    for (let i = 0; i < limit; i++) {
      const node = textNodes[i];
      try {
        if (node.fontName !== figma.mixed) {
          node.fontName = { family: FAMILY, style: styleMap[node.fontName.style] || 'Regular' };
          node.letterSpacing = { value: 0, unit: 'PERCENT' };
          node.lineHeight = { unit: 'AUTO' };
          stats.fonts++;
        }
      } catch(e) {}
      if (i % 30 === 0) {
        figma.ui.postMessage({ type: 'progress', text: 'Шрифты: ' + i + '/' + limit });
        figma.notify('Нормализация... ' + i + '/' + limit, { timeout: 500 });
      }
    }
    figma.notify('✅ Готово!', { timeout: 2000 });
    figma.ui.postMessage({ type: 'action-done', text: 'AI нормализация: ' + stats.fonts + ' текстов, ' + stats.layouts + ' лейаутов' });
  }

  if (msg.type === 'smart-autolayout-prepare') {
    const sel = figma.currentPage.selection;
    if (!sel.length) {
      figma.ui.postMessage({ type: 'action-error', text: 'Выдели фрейм' });
      return;
    }
    const node = sel[0];

    // Export screenshot at 0.25x for token efficiency
    let imageData = null;
    try {
      const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 0.5 } });
      const base64 = figma.base64Encode(bytes);
      imageData = base64;
    } catch(e) {
      figma.ui.postMessage({ type: 'action-error', text: 'Не удалось сделать скриншот: ' + e.message });
      return;
    }

    // Build lean tree - skip invisible, vectors get only bounds
    function buildLeanTree(node, depth) {
      if (depth > 4) return null;
      if ('visible' in node && node.visible === false) return null;
      if ('opacity' in node && node.opacity === 0) return null;

      const item = {
        id: node.id,
        name: node.name,
        type: node.type,
        x: Math.round('x' in node ? node.x : 0),
        y: Math.round('y' in node ? node.y : 0),
        w: Math.round('width' in node ? node.width : 0),
        h: Math.round('height' in node ? node.height : 0),
        isInstance: node.type === 'INSTANCE',
        hasChildren: 'children' in node && node.children.length > 0,
        layoutMode: 'layoutMode' in node ? node.layoutMode : null,
        constraints: 'constraints' in node ? node.constraints : null,
      };

      if ('characters' in node && node.characters) {
        item.text = node.characters.slice(0, 40);
      }

      // Skip internals of instances and vectors
      if (node.type === 'INSTANCE' || node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION') {
        return item;
      }

      if ('children' in node && node.children.length > 0) {
        item.children = node.children
          .map(c => buildLeanTree(c, depth + 1))
          .filter(Boolean);
      }

      return item;
    }

    const tree = buildLeanTree(node, 0);

    // Create undo checkpoint
    figma.commitUndo();

    figma.ui.postMessage({ type: 'smart-autolayout-data', image: imageData, tree: tree, frameId: node.id, frameName: node.name });
  }

  if (msg.type === 'smart-autolayout-apply') {
    const plan = msg.plan;
    let applied = 0;
    let errors = [];

    function getNodeById(id) {
      return figma.getNodeById(id);
    }

    function applyContainer(container) {
      // Apply children first (inside-out)
      if (container.children && container.children.length > 0) {
        container.children.forEach(applyContainer);
      }

      if (!container.nodeIds || container.nodeIds.length < 2) return;

      try {
        // Get all nodes
        const nodes = container.nodeIds.map(getNodeById).filter(Boolean);
        if (nodes.length < 2) return;

        // Check they all have the same parent
        const parent = nodes[0].parent;
        if (!parent || !nodes.every(n => n.parent && n.parent.id === parent.id)) return;

        // Create new auto-layout frame
        const newFrame = figma.createFrame();
        newFrame.name = container.label || 'auto-layout';

        // Calculate bounding box of all nodes
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        nodes.forEach(n => {
          const x = n.absoluteBoundingBox ? n.absoluteBoundingBox.x : n.x;
          const y = n.absoluteBoundingBox ? n.absoluteBoundingBox.y : n.y;
          const w = n.absoluteBoundingBox ? n.absoluteBoundingBox.width : n.width;
          const h = n.absoluteBoundingBox ? n.absoluteBoundingBox.height : n.height;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x + w);
          maxY = Math.max(maxY, y + h);
        });

        // Insert frame at same position as first node
        const insertIndex = parent.children.indexOf(nodes[0]);
        parent.insertChild(insertIndex, newFrame);
        newFrame.x = minX - (parent.absoluteBoundingBox ? parent.absoluteBoundingBox.x : 0);
        newFrame.y = minY - (parent.absoluteBoundingBox ? parent.absoluteBoundingBox.y : 0);
        newFrame.resize(maxX - minX, maxY - minY);
        newFrame.fills = [];
        newFrame.clipsContent = false;

        // Apply auto-layout settings
        newFrame.layoutMode = container.direction || 'HORIZONTAL';
        newFrame.itemSpacing = container.gap || 0;
        newFrame.paddingTop = container.paddingTop || 0;
        newFrame.paddingBottom = container.paddingBottom || 0;
        newFrame.paddingLeft = container.paddingLeft || 0;
        newFrame.paddingRight = container.paddingRight || 0;
        newFrame.primaryAxisAlignItems = container.primaryAxisAlignItems || 'MIN';
        newFrame.counterAxisAlignItems = container.counterAxisAlignItems || 'MIN';
        newFrame.primaryAxisSizingMode = container.primaryAxisSizingMode || 'AUTO';
        newFrame.counterAxisSizingMode = container.counterAxisSizingMode || 'AUTO';

        // Move nodes into new frame
        nodes.forEach(n => {
          newFrame.appendChild(n);
        });

        applied++;
        figma.ui.postMessage({ type: 'progress', text: 'Контейнеры: ' + applied });
      } catch(e) {
        errors.push(container.label + ': ' + e.message);
      }
    }

    if (plan.containers) {
      plan.containers.forEach(applyContainer);
    }

    // Apply renames to existing nodes
    let renamed = 0;
    if (plan.renames) {
      Object.keys(plan.renames).forEach(function(nodeId) {
        try {
          const node = figma.getNodeById(nodeId);
          if (node) { node.name = plan.renames[nodeId]; renamed++; }
        } catch(e) {}
      });
    }

    figma.notify('✅ Готово!', { timeout: 2000 });
    figma.ui.postMessage({
      type: 'action-done',
      text: 'Умный лейаут: ' + applied + ' контейнеров, ' + renamed + ' переименовано' + (errors.length ? '. Ошибки: ' + errors.slice(0,2).join(', ') : '')
    });
  }

  if (msg.type === 'ai-rename-prepare') {
    const sel = figma.currentPage.selection;
    if (!sel.length) {
      figma.ui.postMessage({ type: 'action-error', text: 'Выдели фрейм' });
      return;
    }
    const typeMap = {
      'FRAME': 'frame', 'GROUP': 'group', 'COMPONENT': 'component',
      'INSTANCE': 'instance', 'TEXT': 'text', 'RECTANGLE': 'rect',
      'ELLIPSE': 'ellipse', 'VECTOR': 'vector', 'LINE': 'line',
      'BOOLEAN_OPERATION': 'bool', 'SECTION': 'section', 'IMAGE': 'image'
    };
    function collectTree(node, depth) {
      if (depth > 5) return null;
      var item = {
        id: node.id,
        type: typeMap[node.type] || node.type.toLowerCase(),
        currentName: node.name
      };
      if ('characters' in node && node.characters) item.text = node.characters.slice(0, 60);
      if ('children' in node && node.children.length) {
        item.children = node.children.slice(0, 30).map(function(c) { return collectTree(c, depth + 1); }).filter(Boolean);
      }
      return item;
    }
    var tree = collectTree(sel[0], 0);
    figma.ui.postMessage({ type: 'ai-rename-tree', tree: tree });
  }

  if (msg.type === 'ai-rename-apply') {
    var map = msg.map;
    var count = 0;
    function applyRename(node) {
      if (map[node.id]) { node.name = map[node.id]; count++; }
      if ('children' in node) node.children.forEach(applyRename);
    }
    figma.currentPage.selection.forEach(applyRename);
    figma.ui.postMessage({ type: 'action-done', text: 'AI переименовал ' + count + ' слоёв' });
  }

  if (msg.type === 'apply-autolayout') {
    const sel = figma.currentPage.selection;
    if (!sel.length) {
      figma.ui.postMessage({ type: 'action-error', text: 'Выдели фрейм' });
      return;
    }
    let count = 0;

    function applyLayout(node) {
      if (node.type === 'FRAME' || node.type === 'COMPONENT') {
        if (node.layoutMode === 'NONE' && 'children' in node && node.children.length > 1) {
          const children = node.children;
          let isHorizontal = true;
          for (let i = 1; i < children.length; i++) {
            if ('y' in children[i] && 'y' in children[i-1]) {
              if (Math.abs(children[i].y - children[i-1].y) > Math.abs(children[i].x - children[i-1].x)) {
                isHorizontal = false;
                break;
              }
            }
          }
          node.layoutMode = isHorizontal ? 'HORIZONTAL' : 'VERTICAL';
          node.primaryAxisSizingMode = 'AUTO';
          node.counterAxisSizingMode = 'AUTO';
          node.itemSpacing = 8;
          node.paddingTop = node.paddingBottom = node.paddingLeft = node.paddingRight = 0;
          count++;
          figma.notify('Авто-лейаут: ' + count + ' фреймов...', { timeout: 600 });
        }
      }
      if ('children' in node) node.children.forEach(applyLayout);
    }

    sel.forEach(applyLayout);
    figma.notify('✅ Авто-лейаут готов!', { timeout: 2000 });
    figma.ui.postMessage({ type: 'action-done', text: 'Авто-лейаут применён к ' + count + ' фреймам' });
  }

  if (msg.type === 'ai-normalize') {
    const sel = figma.currentPage.selection;
    if (!sel.length) {
      figma.ui.postMessage({ type: 'action-error', text: 'Выдели фрейм' });
      return;
    }

    let stats = { fonts: 0, layouts: 0 };

    // Step 1: Load fonts
    const FAMILY = msg.fontFamily || 'Inter';
    const styleMap = {
      'Thin':'Regular','Light':'Regular','Regular':'Regular',
      'Medium':'Medium','SemiBold':'Medium','Semi Bold':'Medium',
      'Bold':'Bold','ExtraBold':'Bold','Extra Bold':'Bold','Black':'Bold',
      'Italic':'Regular','Medium Italic':'Medium','Bold Italic':'Bold'
    };

    try {
      await Promise.all([
        figma.loadFontAsync({ family: FAMILY, style: 'Regular' }),
        figma.loadFontAsync({ family: FAMILY, style: 'Medium' }),
        figma.loadFontAsync({ family: FAMILY, style: 'Bold' })
      ]);
    } catch(e) {
      figma.ui.postMessage({ type: 'action-error', text: 'Не удалось загрузить шрифт ' + FAMILY });
      return;
    }

    // Count total nodes first
    let total = 0;
    function countNodes(node) {
      total++;
      if ('children' in node) node.children.forEach(countNodes);
    }
    sel.forEach(countNodes);

    let processed = 0;
    // Collect all text nodes first
    const textNodes = [];
    function collectText(node) {
      if (node.type === 'TEXT') textNodes.push(node);
      if ('children' in node) node.children.forEach(collectText);
    }
    sel.forEach(collectText);

    const limit = Math.min(textNodes.length, 200);
    if (textNodes.length > 200) {
      figma.notify('Много слоёв — обрабатываю первые 200', { timeout: 3000 });
    }

    for (let i = 0; i < limit; i++) {
      const node = textNodes[i];
      try {
        if (node.fontName !== figma.mixed) {
          node.fontName = { family: FAMILY, style: styleMap[node.fontName.style] || 'Regular' };
          node.letterSpacing = { value: 0, unit: 'PERCENT' };
          node.lineHeight = { unit: 'AUTO' };
          stats.fonts++;
        }
      } catch(e) {}
      if (i % 30 === 0) {
        figma.ui.postMessage({ type: 'progress', text: 'Шрифты: ' + i + '/' + limit });
        figma.notify('Нормализация... ' + i + '/' + limit, { timeout: 500 });
      }
    }
    figma.notify('✅ Готово!', { timeout: 2000 });
    figma.ui.postMessage({ type: 'action-done', text: 'AI нормализация: ' + stats.fonts + ' текстов, ' + stats.layouts + ' лейаутов' });
  }

  if (msg.type === 'smart-autolayout-prepare') {
    const sel = figma.currentPage.selection;
    if (!sel.length) {
      figma.ui.postMessage({ type: 'action-error', text: 'Выдели фрейм' });
      return;
    }
    const node = sel[0];

    // Export screenshot at 0.25x for token efficiency
    let imageData = null;
    try {
      const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 0.5 } });
      const base64 = figma.base64Encode(bytes);
      imageData = base64;
    } catch(e) {
      figma.ui.postMessage({ type: 'action-error', text: 'Не удалось сделать скриншот: ' + e.message });
      return;
    }

    // Build lean tree - skip invisible, vectors get only bounds
    function buildLeanTree(node, depth) {
      if (depth > 4) return null;
      if ('visible' in node && node.visible === false) return null;
      if ('opacity' in node && node.opacity === 0) return null;

      const item = {
        id: node.id,
        name: node.name,
        type: node.type,
        x: Math.round('x' in node ? node.x : 0),
        y: Math.round('y' in node ? node.y : 0),
        w: Math.round('width' in node ? node.width : 0),
        h: Math.round('height' in node ? node.height : 0),
        isInstance: node.type === 'INSTANCE',
        hasChildren: 'children' in node && node.children.length > 0,
        layoutMode: 'layoutMode' in node ? node.layoutMode : null,
        constraints: 'constraints' in node ? node.constraints : null,
      };

      if ('characters' in node && node.characters) {
        item.text = node.characters.slice(0, 40);
      }

      // Skip internals of instances and vectors
      if (node.type === 'INSTANCE' || node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION') {
        return item;
      }

      if ('children' in node && node.children.length > 0) {
        item.children = node.children
          .map(c => buildLeanTree(c, depth + 1))
          .filter(Boolean);
      }

      return item;
    }

    const tree = buildLeanTree(node, 0);

    // Create undo checkpoint
    figma.commitUndo();

    figma.ui.postMessage({ type: 'smart-autolayout-data', image: imageData, tree: tree, frameId: node.id, frameName: node.name });
  }

  if (msg.type === 'smart-autolayout-apply') {
    const plan = msg.plan;
    let applied = 0;
    let errors = [];

    function getNodeById(id) {
      return figma.getNodeById(id);
    }

    function applyContainer(container) {
      // Apply children first (inside-out)
      if (container.children && container.children.length > 0) {
        container.children.forEach(applyContainer);
      }

      if (!container.nodeIds || container.nodeIds.length < 2) return;

      try {
        // Get all nodes
        const nodes = container.nodeIds.map(getNodeById).filter(Boolean);
        if (nodes.length < 2) return;

        // Check they all have the same parent
        const parent = nodes[0].parent;
        if (!parent || !nodes.every(n => n.parent && n.parent.id === parent.id)) return;

        // Create new auto-layout frame
        const newFrame = figma.createFrame();
        newFrame.name = container.label || 'auto-layout';

        // Calculate bounding box of all nodes
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        nodes.forEach(n => {
          const x = n.absoluteBoundingBox ? n.absoluteBoundingBox.x : n.x;
          const y = n.absoluteBoundingBox ? n.absoluteBoundingBox.y : n.y;
          const w = n.absoluteBoundingBox ? n.absoluteBoundingBox.width : n.width;
          const h = n.absoluteBoundingBox ? n.absoluteBoundingBox.height : n.height;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x + w);
          maxY = Math.max(maxY, y + h);
        });

        // Insert frame at same position as first node
        const insertIndex = parent.children.indexOf(nodes[0]);
        parent.insertChild(insertIndex, newFrame);
        newFrame.x = minX - (parent.absoluteBoundingBox ? parent.absoluteBoundingBox.x : 0);
        newFrame.y = minY - (parent.absoluteBoundingBox ? parent.absoluteBoundingBox.y : 0);
        newFrame.resize(maxX - minX, maxY - minY);
        newFrame.fills = [];
        newFrame.clipsContent = false;

        // Apply auto-layout settings
        newFrame.layoutMode = container.direction || 'HORIZONTAL';
        newFrame.itemSpacing = container.gap || 0;
        newFrame.paddingTop = container.paddingTop || 0;
        newFrame.paddingBottom = container.paddingBottom || 0;
        newFrame.paddingLeft = container.paddingLeft || 0;
        newFrame.paddingRight = container.paddingRight || 0;
        newFrame.primaryAxisAlignItems = container.primaryAxisAlignItems || 'MIN';
        newFrame.counterAxisAlignItems = container.counterAxisAlignItems || 'MIN';
        newFrame.primaryAxisSizingMode = container.primaryAxisSizingMode || 'AUTO';
        newFrame.counterAxisSizingMode = container.counterAxisSizingMode || 'AUTO';

        // Move nodes into new frame
        nodes.forEach(n => {
          newFrame.appendChild(n);
        });

        applied++;
        figma.ui.postMessage({ type: 'progress', text: 'Контейнеры: ' + applied });
      } catch(e) {
        errors.push(container.label + ': ' + e.message);
      }
    }

    if (plan.containers) {
      plan.containers.forEach(applyContainer);
    }

    // Apply renames to existing nodes
    let renamed = 0;
    if (plan.renames) {
      Object.keys(plan.renames).forEach(function(nodeId) {
        try {
          const node = figma.getNodeById(nodeId);
          if (node) { node.name = plan.renames[nodeId]; renamed++; }
        } catch(e) {}
      });
    }

    figma.notify('✅ Готово!', { timeout: 2000 });
    figma.ui.postMessage({
      type: 'action-done',
      text: 'Умный лейаут: ' + applied + ' контейнеров, ' + renamed + ' переименовано' + (errors.length ? '. Ошибки: ' + errors.slice(0,2).join(', ') : '')
    });
  }

  if (msg.type === 'ai-rename-prepare') {
    const sel = figma.currentPage.selection;
    if (!sel.length) {
      figma.ui.postMessage({ type: 'action-error', text: 'Выдели фрейм' });
      return;
    }
    const typeMap = {
      'FRAME': 'frame', 'GROUP': 'group', 'COMPONENT': 'component',
      'INSTANCE': 'instance', 'TEXT': 'text', 'RECTANGLE': 'rect',
      'ELLIPSE': 'ellipse', 'VECTOR': 'vector', 'LINE': 'line',
      'BOOLEAN_OPERATION': 'bool', 'IMAGE': 'image', 'SECTION': 'section'
    };
    function collectTree(node, depth) {
      if (depth > 3) return null;
      const item = {
        id: node.id,
        t: typeMap[node.type] || node.type.toLowerCase(),
        n: node.name
      };
      if ('characters' in node && node.characters) item.tx = node.characters.slice(0, 40);
      if ('children' in node && node.children.length) {
        item.ch = node.children.slice(0, 20).map(c => collectTree(c, depth + 1)).filter(Boolean);
      }
      return item;
    }
    const tree = collectTree(sel[0], 0);
    figma.ui.postMessage({ type: 'ai-rename-tree', tree });
  }

  if (msg.type === 'ai-rename-apply') {
    const map = msg.map;
    let count = 0;
    function applyRename(node) {
      if (map[node.id]) { node.name = map[node.id]; count++; }
      if ('children' in node) node.children.forEach(applyRename);
    }
    figma.currentPage.selection.forEach(applyRename);
    figma.ui.postMessage({ type: 'action-done', text: 'AI переименовал ' + count + ' слоёв' });
  }

  if (msg.type === 'rename-layers') {
    const sel = figma.currentPage.selection;
    if (!sel.length) {
      figma.ui.postMessage({ type: 'action-error', text: 'Выдели фрейм' });
      return;
    }
    const convention = msg.convention || 'bem';
    let count = 0;

    const typeMap = {
      'FRAME': 'frame', 'GROUP': 'group', 'COMPONENT': 'component',
      'INSTANCE': 'instance', 'TEXT': 'text', 'RECTANGLE': 'rect',
      'ELLIPSE': 'ellipse', 'VECTOR': 'vector', 'LINE': 'line',
      'BOOLEAN_OPERATION': 'bool', 'SECTION': 'section'
    };

    function getBaseName(node) {
      return typeMap[node.type] || node.type.toLowerCase();
    }

    function renameRecursive(node) {
      if (node.type === 'PAGE' || node.type === 'DOCUMENT') return;
      const base = getBaseName(node);
      const slug = node.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_]/g, '');
      node.name = convention === 'camel'
        ? base + '_' + (count + 1)
        : base + '__' + (slug || count + 1);
      count++;
      if ('children' in node) node.children.forEach(renameRecursive);
    }

    sel.forEach(node => {
      if ('children' in node) node.children.forEach(renameRecursive);
      else renameRecursive(node);
    });

    figma.ui.postMessage({ type: 'action-done', text: 'Переименовано ' + count + ' слоёв' });
  }

  if (msg.type === 'claude-request') {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': msg.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(msg.payload)
      });
      let data;
      try { data = await resp.json(); } catch(e) {
        figma.ui.postMessage({ type: 'claude-error', requestId: msg.requestId, error: 'Не JSON. HTTP: ' + resp.status });
        return;
      }
      if (!resp.ok) {
        const errMsg = data && data.error ? data.error.message : JSON.stringify(data);
        figma.ui.postMessage({ type: 'claude-error', requestId: msg.requestId, error: 'HTTP ' + resp.status + ': ' + errMsg });
        return;
      }
      figma.ui.postMessage({ type: 'claude-response', requestId: msg.requestId, data });
    } catch(e) {
      figma.ui.postMessage({ type: 'claude-error', requestId: msg.requestId, error: 'Fetch error: ' + e.message });
    }
  }

  if (msg.type === 'use-selected-frame') {
    const sel = figma.currentPage.selection;
    if (sel.length === 1) {
      figma.ui.postMessage({ type: 'selected-frame-for-action', node: { id: sel[0].id, name: sel[0].name } });
    } else {
      figma.ui.postMessage({ type: 'error', text: 'Ничего не выделено' });
    }
  }

  if (msg.type === 'extract-components-prepare') {
    const sel = figma.currentPage.selection;
    if (!sel.length) {
      figma.ui.postMessage({ type: 'action-error', text: 'Выдели фрейм' });
      return;
    }
    const node = sel[0];
    const typeMap = {
      'FRAME':'frame','GROUP':'group','COMPONENT':'component',
      'INSTANCE':'instance','TEXT':'text','RECTANGLE':'rect',
      'ELLIPSE':'ellipse','VECTOR':'vector','LINE':'line'
    };
    function buildTree(n, depth) {
      if (depth > 4) return null;
      const item = {
        id: n.id, name: n.name,
        type: typeMap[n.type] || n.type.toLowerCase(),
        w: Math.round('width' in n ? n.width : 0),
        h: Math.round('height' in n ? n.height : 0),
        isInstance: n.type === 'INSTANCE',
        componentName: n.type === 'INSTANCE' && n.mainComponent ? n.mainComponent.name : null
      };
      if ('characters' in n && n.characters) item.text = n.characters.slice(0, 40);
      if ('children' in n && n.children.length && n.type !== 'INSTANCE') {
        item.children = n.children.slice(0, 20).map(c => buildTree(c, depth+1)).filter(Boolean);
      }
      return item;
    }
    const tree = buildTree(node, 0);
    figma.ui.postMessage({ type: 'extract-components-tree', tree, frameName: node.name });
  }

  if (msg.type === 'extract-components-apply') {
    const components = msg.components;
    if (!components || !components.length) {
      figma.ui.postMessage({ type: 'action-error', text: 'Нет компонентов для извлечения' });
      return;
    }

    figma.commitUndo();

    const GAP_STATES = 16;
    const GAP_COMPONENTS = 40;
    const LABEL_SIZE = 14;
    const STATE_PADDING = 12;

    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });

    // Create container frame
    const container = figma.createFrame();
    container.name = 'Extracted Components';
    container.layoutMode = 'VERTICAL';
    container.primaryAxisSizingMode = 'AUTO';
    container.counterAxisSizingMode = 'AUTO';
    container.itemSpacing = GAP_COMPONENTS;
    container.paddingTop = 32;
    container.paddingBottom = 32;
    container.paddingLeft = 32;
    container.paddingRight = 32;
    container.fills = [{ type: 'SOLID', color: { r: 0.97, g: 0.97, b: 0.98 } }];
    container.cornerRadius = 16;

    // Position next to current selection
    const sel = figma.currentPage.selection;
    if (sel.length) {
      container.x = sel[0].x + sel[0].width + 80;
      container.y = sel[0].y;
    }

    figma.currentPage.appendChild(container);

    for (const comp of components) {
      // Component group: label + states row
      const group = figma.createFrame();
      group.name = comp.label;
      group.layoutMode = 'VERTICAL';
      group.primaryAxisSizingMode = 'AUTO';
      group.counterAxisSizingMode = 'AUTO';
      group.itemSpacing = 12;
      group.fills = [];
      container.appendChild(group);

      // Label
      const label = figma.createText();
      label.characters = comp.label;
      label.fontSize = LABEL_SIZE;
      label.fontName = { family: 'Inter', style: 'Medium' };
      label.fills = [{ type: 'SOLID', color: { r: 0.12, g: 0.18, b: 0.24 } }];
      group.appendChild(label);

      // States row
      const statesRow = figma.createFrame();
      statesRow.name = comp.label + '__states';
      statesRow.layoutMode = 'HORIZONTAL';
      statesRow.primaryAxisSizingMode = 'AUTO';
      statesRow.counterAxisSizingMode = 'AUTO';
      statesRow.itemSpacing = GAP_STATES;
      statesRow.fills = [];
      group.appendChild(statesRow);

      // Get source node
      const sourceNode = figma.getNodeById(comp.nodeId);

      for (const state of comp.states) {
        // State wrapper
        const stateWrap = figma.createFrame();
        stateWrap.name = 'State=' + state;
        stateWrap.layoutMode = 'VERTICAL';
        stateWrap.primaryAxisSizingMode = 'AUTO';
        stateWrap.counterAxisSizingMode = 'AUTO';
        stateWrap.itemSpacing = 8;
        stateWrap.fills = [];
        statesRow.appendChild(stateWrap);

        // State label
        const stateLabel = figma.createText();
        stateLabel.characters = state;
        stateLabel.fontSize = 11;
        stateLabel.fontName = { family: 'Inter', style: 'Regular' };
        stateLabel.fills = [{ type: 'SOLID', color: { r: 0.49, g: 0.54, b: 0.58 } }];
        stateWrap.appendChild(stateLabel);

        // Component copy
        if (sourceNode) {
          try {
            const copy = sourceNode.clone();
            copy.name = comp.type + '/' + state;
            stateWrap.appendChild(copy);
          } catch(e) {
            const placeholder = figma.createFrame();
            placeholder.name = comp.type + '/' + state;
            placeholder.resize(sourceNode ? sourceNode.width : 80, sourceNode ? sourceNode.height : 40);
            placeholder.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.92, b: 0.95 } }];
            placeholder.cornerRadius = 8;
            stateWrap.appendChild(placeholder);
          }
        }
      }
    }

    figma.viewport.scrollAndZoomIntoView([container]);
    figma.ui.postMessage({
      type: 'action-done',
      text: 'Извлечено ' + components.length + ' компонентов со стейтами'
    });
  }

  if (msg.type === 'save-memory') {
    await figma.clientStorage.setAsync('figment_memory', msg.memory);
  }

  if (msg.type === 'load-memory') {
    const mem = await figma.clientStorage.getAsync('figment_memory');
    figma.ui.postMessage({ type: 'memory-loaded', memory: mem || {} });
  }

  if (msg.type === 'notify') {
    figma.notify(msg.text);
  }
};
