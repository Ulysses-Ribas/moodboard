import type { Board, BoardItem, BoardState } from './types';
import { isIdbRef, getImage } from './imageStore';

/** Detect whether a string contains HTML tags */
export function isHtml(str: string): boolean {
  return /<[a-z][\s\S]*>/i.test(str);
}

/** Walk DOM text nodes and convert bare URLs to clickable <a> tags (skips existing links) */
export function autoLinkTextNodes(container: HTMLElement): void {
  const URL_RE = /(https?:\/\/[^\s<>"']+)/gi;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Skip text inside <a> tags
      if (node.parentElement?.closest('a')) return NodeFilter.FILTER_REJECT;
      return URL_RE.test(node.textContent || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    URL_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    let match: RegExpExecArray | null;

    while ((match = URL_RE.exec(text)) !== null) {
      if (match.index > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
      }
      const a = document.createElement('a');
      a.href = match[0];
      a.textContent = match[0];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      frag.appendChild(a);
      lastIdx = match.index + match[0].length;
    }
    if (lastIdx < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    }
    textNode.replaceWith(frag);
  }
}

/** Convert plain text to HTML (escape entities, newlines to <br>) */
export function plainTextToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\n/g, '<br>');
}

interface ToolbarCallbacks {
  onHome: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onZoomFit: () => void;
  onBoardNameChange: (name: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  onExportPng: () => void;
  onExportJpeg: () => void;
  onExportSvg: () => void;
  onExportPdf: () => void;
  onImport: () => void;
  onPresent: () => void;
  onSlideOrder: () => void;
  onToggleTheme: () => void;
}

function svgEl(paths: string, viewBox = '0 0 24 24'): string {
  return `<svg viewBox="${viewBox}"><path d="${paths}" /></svg>`;
}

export interface SidebarCallbacks {
  onSelect: () => void;
  onAddText: () => void;
  onAddImage: (file: File) => void;
  onAddColor: () => void;
  onAddLink: () => void;
  onAddNote: () => void;
  onAddFrame: () => void;
  onAddBoard: () => void;
  onConnect: () => void;
  onDraw: () => void;
}

export function renderSidebar(
  container: HTMLElement,
  cb: SidebarCallbacks
): HTMLElement {
  const sidebar = document.createElement('div');
  sidebar.id = 'sidebar';

  // Select tool (pointer / arrow)
  const btnSelect = document.createElement('button');
  btnSelect.className = 'sidebar-btn active';
  btnSelect.id = 'sidebar-select-btn';
  btnSelect.dataset.tooltip = 'Selecionar (V)';
  btnSelect.innerHTML = svgEl('M4 4l7 19 2.5-7.5L21 13z');
  btnSelect.addEventListener('click', cb.onSelect);

  const sep0 = document.createElement('div');
  sep0.className = 'sidebar-sep';

  // Text tool
  const btnText = document.createElement('button');
  btnText.className = 'sidebar-btn';
  btnText.dataset.tooltip = 'Adicionar texto (T)';
  btnText.innerHTML = svgEl('M4 7V4h16v3 M9 20h6 M12 4v16');
  btnText.addEventListener('click', cb.onAddText);

  // Image tool
  const btnImage = document.createElement('button');
  btnImage.className = 'sidebar-btn';
  btnImage.dataset.tooltip = 'Adicionar imagem';
  btnImage.innerHTML = svgEl('M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M21 15l-5-5L5 21');

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) cb.onAddImage(file);
    fileInput.value = '';
  });
  btnImage.addEventListener('click', () => fileInput.click());

  // Color tool
  const btnColor = document.createElement('button');
  btnColor.className = 'sidebar-btn';
  btnColor.dataset.tooltip = 'Adicionar cor';
  btnColor.innerHTML = svgEl('M12 22a7 7 0 0 0 7-7c0-4-7-13-7-13S5 11 5 15a7 7 0 0 0 7 7z');
  btnColor.addEventListener('click', cb.onAddColor);

  // Link tool
  const btnLink = document.createElement('button');
  btnLink.className = 'sidebar-btn';
  btnLink.dataset.tooltip = 'Adicionar link';
  btnLink.innerHTML = svgEl('M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71');
  btnLink.addEventListener('click', cb.onAddLink);

  // Draw tool
  const btnDraw = document.createElement('button');
  btnDraw.className = 'sidebar-btn';
  btnDraw.dataset.tooltip = 'Desenho livre (D)';
  btnDraw.innerHTML = svgEl('M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z M20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z');
  btnDraw.addEventListener('click', cb.onDraw);

  const sep = document.createElement('div');
  sep.className = 'sidebar-sep';

  // Frame tool
  const btnFrame = document.createElement('button');
  btnFrame.className = 'sidebar-btn';
  btnFrame.dataset.tooltip = 'Frame (F)';
  btnFrame.innerHTML = svgEl('M3 3h18v18H3z M3 9h18 M9 3v18', '0 0 24 24');
  btnFrame.addEventListener('click', cb.onAddFrame);

  // Sub-board tool
  const btnBoard = document.createElement('button');
  btnBoard.className = 'sidebar-btn';
  btnBoard.dataset.tooltip = 'Sub-board (B)';
  btnBoard.innerHTML = svgEl('M3 3h18v18H3z M3 9h18 M9 9v12', '0 0 24 24');
  btnBoard.addEventListener('click', cb.onAddBoard);

  // Connect tool
  const btnConnect = document.createElement('button');
  btnConnect.className = 'sidebar-btn';
  btnConnect.id = 'sidebar-connect-btn';
  btnConnect.dataset.tooltip = 'Conectar (C)';
  btnConnect.innerHTML = svgEl('M8 12h8 M16 8l4 4-4 4 M4 8a4 4 0 0 1 0 8');
  btnConnect.addEventListener('click', cb.onConnect);

  sidebar.append(btnSelect, sep0, btnText, btnImage, btnColor, btnLink, btnDraw, fileInput, sep, btnFrame, btnBoard, btnConnect);
  container.prepend(sidebar);
  return sidebar;
}

export function renderToolbar(
  container: HTMLElement,
  boardName: string,
  cb: ToolbarCallbacks
): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.id = 'toolbar';

  // Home button
  const homeBtn = document.createElement('button');
  homeBtn.className = 'toolbar-btn-icon';
  homeBtn.title = 'Voltar ao início';
  homeBtn.innerHTML = svgEl('M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10');
  homeBtn.addEventListener('click', cb.onHome);

  // Board name (editable)
  const nameEl = document.createElement('span');
  nameEl.id = 'board-name';
  nameEl.className = 'toolbar-title';
  nameEl.textContent = boardName;
  nameEl.title = 'Clique para renomear';
  nameEl.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'toolbar-name-input';
    input.value = nameEl.textContent || '';
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
      const val = input.value.trim() || 'Sem título';
      nameEl.textContent = val;
      input.replaceWith(nameEl);
      cb.onBoardNameChange(val);
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = nameEl.textContent || ''; input.blur(); }
      e.stopPropagation();
    });
  });

  const sep1 = document.createElement('span');
  sep1.className = 'toolbar-sep';

  // Undo / Redo buttons
  const btnUndo = document.createElement('button');
  btnUndo.id = 'btn-undo';
  btnUndo.className = 'toolbar-btn-icon';
  btnUndo.title = 'Desfazer (Ctrl+Z)';
  btnUndo.innerHTML = svgEl('M3 10h10a5 5 0 0 1 0 10H9 M3 10l4-4 M3 10l4 4');
  btnUndo.disabled = true;
  btnUndo.addEventListener('click', cb.onUndo);

  const btnRedo = document.createElement('button');
  btnRedo.id = 'btn-redo';
  btnRedo.className = 'toolbar-btn-icon';
  btnRedo.title = 'Refazer (Ctrl+Shift+Z)';
  btnRedo.innerHTML = svgEl('M21 10H11a5 5 0 0 0 0 10h4 M21 10l-4-4 M21 10l-4 4');
  btnRedo.disabled = true;
  btnRedo.addEventListener('click', cb.onRedo);

  const sep2 = document.createElement('span');
  sep2.className = 'toolbar-sep';

  // Export dropdown
  const exportWrap = document.createElement('div');
  exportWrap.className = 'export-dropdown-wrap';

  const btnExport = document.createElement('button');
  btnExport.className = 'toolbar-btn';
  btnExport.textContent = 'Exportar ▾';
  btnExport.title = 'Exportar board';

  let exportDropdown: HTMLElement | null = null;
  const closeExportDrop = () => {
    if (exportDropdown) { exportDropdown.remove(); exportDropdown = null; }
  };

  btnExport.addEventListener('click', (e) => {
    e.stopPropagation();
    if (exportDropdown) { closeExportDrop(); return; }
    const drop = document.createElement('div');
    drop.className = 'export-dropdown';
    exportDropdown = drop;

    const items: { label: string; ext: string; action: () => void; sep?: boolean }[] = [
      { label: 'Board JSON', ext: '.json', action: () => { closeExportDrop(); cb.onExport(); } },
      { label: 'Imagem PNG', ext: '.png', action: () => { closeExportDrop(); cb.onExportPng(); }, sep: true },
      { label: 'Imagem JPEG', ext: '.jpg', action: () => { closeExportDrop(); cb.onExportJpeg(); } },
      { label: 'Vetor SVG', ext: '.svg', action: () => { closeExportDrop(); cb.onExportSvg(); }, sep: true },
      { label: 'Frames PDF', ext: '.pdf', action: () => { closeExportDrop(); cb.onExportPdf(); } },
    ];

    for (const item of items) {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'export-dropdown-sep';
        drop.appendChild(sep);
      }
      const btn = document.createElement('button');
      btn.className = 'export-dropdown-item';
      btn.innerHTML = `${item.label}<span class="export-ext">${item.ext}</span>`;
      btn.addEventListener('click', item.action);
      drop.appendChild(btn);
    }

    exportWrap.appendChild(drop);

    // Close on outside click
    const onDocClick = () => { closeExportDrop(); document.removeEventListener('click', onDocClick); };
    setTimeout(() => document.addEventListener('click', onDocClick), 0);
  });

  exportWrap.appendChild(btnExport);

  const btnImport = document.createElement('button');
  btnImport.className = 'toolbar-btn';
  btnImport.textContent = 'Importar';
  btnImport.title = 'Ctrl+O';
  btnImport.addEventListener('click', cb.onImport);

  const sep3 = document.createElement('span');
  sep3.className = 'toolbar-sep';

  const slideOrderWrap = document.createElement('div');
  slideOrderWrap.id = 'slide-order-wrap';
  slideOrderWrap.style.position = 'relative';

  const btnSlideOrder = document.createElement('button');
  btnSlideOrder.className = 'toolbar-btn-icon';
  btnSlideOrder.title = 'Ordem dos slides';
  btnSlideOrder.innerHTML = svgEl('M4 6h16 M4 12h16 M4 18h16 M8 6v0 M8 12v0 M8 18v0', '0 0 24 24');
  btnSlideOrder.addEventListener('click', cb.onSlideOrder);
  slideOrderWrap.appendChild(btnSlideOrder);

  const btnPresent = document.createElement('button');
  btnPresent.className = 'toolbar-btn-icon';
  btnPresent.title = 'Apresentar (P)';
  btnPresent.innerHTML = svgEl('M5 3l14 9-14 9V3z');
  btnPresent.addEventListener('click', cb.onPresent);

  const spacer = document.createElement('span');
  spacer.style.flex = '1';

  // Zoom controls
  const zoomGroup = document.createElement('div');
  zoomGroup.className = 'toolbar-zoom-group';

  const btnOut = document.createElement('button');
  btnOut.className = 'toolbar-btn-small';
  btnOut.textContent = '−';
  btnOut.title = 'Zoom out';
  btnOut.addEventListener('click', cb.onZoomOut);

  const zoomLabel = document.createElement('button');
  zoomLabel.id = 'zoom-label';
  zoomLabel.className = 'toolbar-btn-small zoom-label';
  zoomLabel.textContent = '100%';
  zoomLabel.title = 'Resetar zoom';
  zoomLabel.addEventListener('click', cb.onZoomReset);

  const btnIn = document.createElement('button');
  btnIn.className = 'toolbar-btn-small';
  btnIn.textContent = '+';
  btnIn.title = 'Zoom in';
  btnIn.addEventListener('click', cb.onZoomIn);

  const btnFit = document.createElement('button');
  btnFit.className = 'toolbar-btn-small';
  btnFit.innerHTML = svgEl('M4 14H2v6h6v-2H4v-4z M20 14h2v6h-6v-2h4v-4z M14 4v-2h6v6h-2V4h-4z M4 4h4V2H2v6h2V4z', '0 0 24 24');
  btnFit.title = 'Zoom para enquadrar tudo';
  btnFit.addEventListener('click', cb.onZoomFit);

  zoomGroup.append(btnOut, zoomLabel, btnIn, btnFit);

  // Theme toggle
  const btnTheme = document.createElement('button');
  btnTheme.id = 'btn-theme';
  btnTheme.className = 'toolbar-btn-icon';
  btnTheme.title = 'Alternar tema claro/escuro';
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  // Sun icon for dark mode (click to go light), moon icon for light mode (click to go dark)
  const sunPath = 'M12 3v1m0 16v1m-8-9H3m18 0h-1m-2.636-6.364l-.707.707M6.343 17.657l-.707.707m0-12.728l.707.707m11.314 11.314l.707.707 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z';
  const moonPath = 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z';
  btnTheme.innerHTML = svgEl(isDark ? sunPath : moonPath);
  btnTheme.addEventListener('click', () => {
    cb.onToggleTheme();
    const nowDark = document.documentElement.getAttribute('data-theme') === 'dark';
    btnTheme.innerHTML = svgEl(nowDark ? sunPath : moonPath);
  });

  // Shortcuts popover button
  const shortcutsWrap = document.createElement('div');
  shortcutsWrap.style.position = 'relative';

  const btnShortcuts = document.createElement('button');
  btnShortcuts.className = 'toolbar-btn-icon';
  btnShortcuts.title = 'Atalhos do teclado';
  btnShortcuts.innerHTML = svgEl('M18 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z M8 7h1 M15 7h1 M8 11h8 M8 15h5');

  let shortcutsPopover: HTMLElement | null = null;
  const closeShortcuts = () => {
    if (shortcutsPopover) { shortcutsPopover.remove(); shortcutsPopover = null; }
  };

  btnShortcuts.addEventListener('click', (e) => {
    e.stopPropagation();
    if (shortcutsPopover) { closeShortcuts(); return; }

    const pop = document.createElement('div');
    pop.className = 'shortcuts-popover';
    shortcutsPopover = pop;

    const title = document.createElement('div');
    title.className = 'shortcuts-popover-title';
    title.textContent = 'Atalhos do teclado';
    pop.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'shortcuts-grid';

    const shortcuts: [string, string][] = [
      ['Espaço + arrastar', 'Mover canvas'],
      ['Scroll', 'Zoom'],
      ['V', 'Ferramenta de seleção'],
      ['D', 'Ferramenta de desenho'],
      ['T', 'Novo texto'],
      ['L', 'Bloquear/desbloquear'],
      ['P', 'Apresentar'],
      ['Ctrl+D', 'Duplicar'],
      ['Ctrl+C / V', 'Copiar / Colar'],
      ['Ctrl+Z', 'Desfazer'],
      ['Ctrl+Shift+Z', 'Refazer'],
      ['Ctrl+F', 'Buscar'],
      ['Ctrl+O', 'Importar'],
      ['Delete', 'Excluir'],
      ['Escape', 'Cancelar / Desselecionar'],
      ['↑ ↓ ← →', 'Mover item'],
    ];

    for (const [key, desc] of shortcuts) {
      const keyEl = document.createElement('span');
      keyEl.className = 'shortcut-key';
      keyEl.textContent = key;
      grid.appendChild(keyEl);

      const descEl = document.createElement('span');
      descEl.className = 'shortcut-desc';
      descEl.textContent = desc;
      grid.appendChild(descEl);
    }

    pop.appendChild(grid);
    shortcutsWrap.appendChild(pop);

    const onDocClick = () => { closeShortcuts(); document.removeEventListener('click', onDocClick); };
    setTimeout(() => document.addEventListener('click', onDocClick), 0);
  });

  shortcutsWrap.appendChild(btnShortcuts);

  toolbar.append(homeBtn, nameEl, sep1, btnUndo, btnRedo, sep2, exportWrap, btnImport, spacer, slideOrderWrap, btnPresent, sep3, zoomGroup, btnTheme, shortcutsWrap);
  container.prepend(toolbar);
  return toolbar;
}

export function updateUndoRedoButtons(canUndoVal: boolean, canRedoVal: boolean): void {
  const btnUndo = document.getElementById('btn-undo') as HTMLButtonElement | null;
  const btnRedo = document.getElementById('btn-redo') as HTMLButtonElement | null;
  if (btnUndo) btnUndo.disabled = !canUndoVal;
  if (btnRedo) btnRedo.disabled = !canRedoVal;
}

export function renderStatusBar(container: HTMLElement): void {
  const bar = document.createElement('div');
  bar.id = 'status-bar';
  const hints = [
    'Espaço+arrastar  mover canvas',
    'Scroll  zoom',
    'T  texto',
    'Ctrl+D  duplicar',
    'Ctrl+C/V  copiar/colar',
    '↑↓←→  mover item',
    'L  bloquear',
    'Ctrl+F  buscar',
    'Ctrl+Z  desfazer',
    'Delete  excluir',
  ];
  for (const hint of hints) {
    const span = document.createElement('span');
    span.textContent = hint;
    bar.appendChild(span);
  }
  container.appendChild(bar);
}

// --- Board Tabs ---

interface BoardTabsCallbacks {
  onSwitch: (boardId: string) => void;
  onNew: () => void;
  onDelete: (boardId: string) => void;
  onRename: (boardId: string, name: string) => void;
}

export function renderBoardTabs(
  container: HTMLElement,
  boards: Board[],
  activeBoardId: string | null,
  cb: BoardTabsCallbacks
): void {
  let bar = document.getElementById('board-tabs');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'board-tabs';
    // Insert after toolbar, before canvas
    const toolbar = document.getElementById('toolbar');
    if (toolbar && toolbar.nextSibling) {
      container.insertBefore(bar, toolbar.nextSibling);
    } else {
      container.appendChild(bar);
    }
  }
  bar.innerHTML = '';

  for (const board of boards) {
    const isActive = board.id === activeBoardId;
    const tab = document.createElement('div');
    tab.className = `board-tab${isActive ? ' active' : ''}`;
    tab.dataset.boardId = board.id;

    const label = document.createElement('span');
    label.className = 'board-tab-label';
    label.textContent = board.name || 'Sem título';
    tab.appendChild(label);

    // Click to switch
    tab.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.board-tab-close')) return;
      if (!isActive) cb.onSwitch(board.id);
    });

    // Double-click to rename
    label.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'board-tab-input';
      input.value = label.textContent || '';
      label.replaceWith(input);
      input.focus();
      input.select();

      const commit = () => {
        const val = input.value.trim() || 'Sem título';
        label.textContent = val;
        input.replaceWith(label);
        cb.onRename(board.id, val);
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') input.blur();
        if (ke.key === 'Escape') { input.value = label.textContent || ''; input.blur(); }
        ke.stopPropagation();
      });
    });

    // Close button (only if more than 1 board)
    if (boards.length > 1) {
      const close = document.createElement('button');
      close.className = 'board-tab-close';
      close.textContent = '×';
      close.title = 'Excluir board';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        cb.onDelete(board.id);
      });
      tab.appendChild(close);
    }

    bar.appendChild(tab);
  }

  // New board button
  const addBtn = document.createElement('button');
  addBtn.className = 'board-tab-add';
  addBtn.textContent = '+';
  addBtn.title = 'Novo board';
  addBtn.addEventListener('click', cb.onNew);
  bar.appendChild(addBtn);
}

export function updateZoomLabel(zoom: number): void {
  const label = document.getElementById('zoom-label');
  if (label) label.textContent = `${Math.round(zoom * 100)}%`;
}

export function renderItem(item: BoardItem, isSelected: boolean, cssZIndex?: number): HTMLElement {
  const el = document.createElement('div');
  el.dataset.itemId = item.id;
  el.className = `board-item item-${item.type}${isSelected ? ' selected' : ''}${item.locked ? ' locked' : ''}`;
  el.style.position = 'absolute';
  el.style.left = `${item.position.x}px`;
  el.style.top = `${item.position.y}px`;
  el.style.width = `${item.size.w}px`;
  el.style.height = `${item.size.h}px`;
  el.style.zIndex = String(cssZIndex ?? item.zIndex);

  if (item.type === 'text') {
    // Apply custom background color
    if (item.color === 'transparent') {
      el.style.background = 'transparent';
      el.style.border = 'none';
      el.style.boxShadow = 'none';
    } else if (item.color) {
      el.style.backgroundColor = item.color;
    }

    const content = document.createElement('div');
    content.className = 'item-content';

    if (!item.content) {
      const p = document.createElement('p');
      p.textContent = 'Clique duas vezes para editar';
      p.classList.add('placeholder');
      content.appendChild(p);
    } else if (isHtml(item.content)) {
      content.innerHTML = item.content;
    } else {
      content.innerHTML = plainTextToHtml(item.content);
    }

    // Auto-link bare URLs in text nodes
    autoLinkTextNodes(content);

    // Ensure all links open in new tab
    const links = content.querySelectorAll('a');
    for (const a of Array.from(links)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }

    el.appendChild(content);
  }

  if (item.type === 'image') {
    const img = document.createElement('img');
    if (isIdbRef(item.content)) {
      img.dataset.idbRef = item.content;
      getImage(item.content).then(dataUrl => {
        if (dataUrl) img.src = dataUrl;
      });
    } else {
      img.src = item.content;
    }
    img.draggable = false;
    el.appendChild(img);

    // Link button on selected images — only show when a link already exists
    if (isSelected && item.sourceUrl) {
      const linkBtn = document.createElement('button');
      linkBtn.className = 'image-link-btn has-link';
      linkBtn.title = `Link: ${item.sourceUrl}`;
      linkBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>';
      linkBtn.dataset.action = 'image-link';
      el.appendChild(linkBtn);
    }
  }

  if (item.type === 'color') {
    const swatch = document.createElement('div');
    swatch.className = 'item-swatch';
    swatch.style.backgroundColor = item.content || '#cccccc';
    el.appendChild(swatch);

    const label = document.createElement('div');
    label.className = 'item-color-label';
    label.textContent = (item.content || '#cccccc').toUpperCase();
    el.appendChild(label);
  }

  if (item.type === 'link') {
    let domain = '';
    try {
      domain = new URL(item.content).hostname.replace(/^www\./, '');
    } catch { domain = item.content; }

    const favicon = document.createElement('img');
    favicon.className = 'item-link-favicon';
    favicon.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    favicon.alt = '';
    favicon.draggable = false;

    const info = document.createElement('div');
    info.className = 'item-link-info';

    const domainEl = document.createElement('div');
    domainEl.className = 'item-link-domain';
    domainEl.textContent = domain;

    const urlEl = document.createElement('div');
    urlEl.className = 'item-link-url';
    urlEl.textContent = item.content;

    info.append(domainEl, urlEl);
    el.append(favicon, info);
  }

  if (item.type === 'frame') {
    el.style.backgroundColor = item.color || 'rgba(216, 212, 204, 0.25)';

    const titleBar = document.createElement('div');
    titleBar.className = 'item-frame-title';
    titleBar.textContent = item.content || 'Frame';
    el.appendChild(titleBar);
  }

  if (item.type === 'board') {
    // Sub-board card
    const icon = document.createElement('div');
    icon.className = 'item-board-icon';
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="21"/></svg>';

    const label = document.createElement('div');
    label.className = 'item-board-label';
    // content = boardId — resolve name from global state if available
    label.textContent = item.content ? '…' : 'Sub-board';
    // The actual name will be patched by renderAllItems after creation

    const hint = document.createElement('div');
    hint.className = 'item-board-hint';
    hint.textContent = 'Duplo-clique para abrir';

    el.append(icon, label, hint);
  }

  if (item.type === 'note') {
    el.style.backgroundColor = item.color || '#fff9c4';

    const content = document.createElement('div');
    content.className = 'item-content';

    if (!item.content) {
      const p = document.createElement('p');
      p.textContent = 'Clique duas vezes para editar';
      p.classList.add('placeholder');
      content.appendChild(p);
    } else if (isHtml(item.content)) {
      content.innerHTML = item.content;
    } else {
      content.innerHTML = plainTextToHtml(item.content);
    }

    autoLinkTextNodes(content);

    const links = content.querySelectorAll('a');
    for (const a of Array.from(links)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }

    el.appendChild(content);
  }

  if (item.type === 'draw') {
    el.style.overflow = 'visible';
    el.style.backgroundColor = 'transparent';
    el.style.border = 'none';
    el.style.boxShadow = 'none';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${item.size.w} ${item.size.h}`);
    svg.setAttribute('width', String(item.size.w));
    svg.setAttribute('height', String(item.size.h));
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.overflow = 'visible';

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', item.content || '');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', item.color || 'var(--ink)');
    path.setAttribute('stroke-width', String(item.strokeWidth || 3));
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    el.appendChild(svg);
  }

  // Lock indicator
  if (item.locked) {
    const lockIcon = document.createElement('div');
    lockIcon.className = 'lock-indicator';
    lockIcon.innerHTML = '<svg viewBox="0 0 16 16"><rect x="3" y="7" width="10" height="8" rx="1" /><path d="M5 7V5a3 3 0 0 1 6 0v2" /></svg>';
    el.appendChild(lockIcon);
  }

  // Group indicator
  if (item.groupId) {
    const groupIcon = document.createElement('div');
    groupIcon.className = 'group-indicator';
    groupIcon.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 4H4a2 2 0 0 0 0 4h2 M10 4h2a2 2 0 0 1 0 4h-2 M5 8h6"/></svg>';
    el.appendChild(groupIcon);
  }

  // Tags
  if (item.tags && item.tags.length > 0) {
    const tagBar = document.createElement('div');
    tagBar.className = 'item-tags';
    for (const tag of item.tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.dataset.tag = tag;
      chip.textContent = tag;
      tagBar.appendChild(chip);
    }
    el.appendChild(tagBar);
  }

  if (isSelected) {
    for (const corner of ['nw', 'ne', 'sw', 'se'] as const) {
      const handle = document.createElement('div');
      handle.className = 'resize-handle';
      handle.dataset.corner = corner;
      el.appendChild(handle);
    }
  }

  return el;
}

export function renderAllItems(
  state: BoardState,
  layer: HTMLElement,
  selectedIds: Set<string>
): void {
  const board = state.boards.find(b => b.id === state.activeBoardId);
  if (!board) return;

  // Remove only board-item elements, preserving overlay SVGs (connections, etc.)
  const oldItems = layer.querySelectorAll('.board-item');
  for (const el of Array.from(oldItems)) el.remove();

  // Sort: frames always first (behind), then by zIndex
  const sorted = [...board.items].sort((a, b) => {
    const aFrame = a.type === 'frame' ? 0 : 1;
    const bFrame = b.type === 'frame' ? 0 : 1;
    if (aFrame !== bFrame) return aFrame - bFrame;
    return a.zIndex - b.zIndex;
  });
  // Use sort position as CSS z-index (1..N) so values stay well below the
  // connection-layer SVG z-index (10 000).  The data-model zIndex (Date.now
  // timestamps) is kept for sort stability — only the CSS value is normalised.
  for (let i = 0; i < sorted.length; i++) {
    const el = renderItem(sorted[i], selectedIds.has(sorted[i].id), i + 1);

    // Patch sub-board cards with actual board name + item count
    if (sorted[i].type === 'board' && sorted[i].content) {
      const sub = state.boards.find(b => b.id === sorted[i].content);
      const labelEl = el.querySelector('.item-board-label');
      if (labelEl) labelEl.textContent = sub?.name || 'Sub-board';
      const hintEl = el.querySelector('.item-board-hint');
      if (hintEl && sub) hintEl.textContent = `${sub.items.length} ${sub.items.length === 1 ? 'item' : 'itens'} · duplo-clique para abrir`;
    }

    layer.appendChild(el);
  }

  // Re-append direct-child overlay SVGs so they stay on top of items
  const overlays = layer.querySelectorAll(':scope > svg');
  for (const svg of Array.from(overlays)) layer.appendChild(svg);
}

export function syncSelectionVisual(
  layer: HTMLElement,
  selectedIds: Set<string>,
  findItem?: (id: string) => BoardItem | undefined
): void {
  const items = layer.querySelectorAll('[data-item-id]');
  for (const el of Array.from(items)) {
    const htmlEl = el as HTMLElement;
    const id = htmlEl.dataset.itemId!;
    const isSelected = selectedIds.has(id);

    htmlEl.classList.toggle('selected', isSelected);

    const existingHandles = htmlEl.querySelectorAll('.resize-handle');
    if (isSelected && existingHandles.length === 0) {
      for (const corner of ['nw', 'ne', 'sw', 'se'] as const) {
        const handle = document.createElement('div');
        handle.className = 'resize-handle';
        handle.dataset.corner = corner;
        htmlEl.appendChild(handle);
      }
    } else if (!isSelected && existingHandles.length > 0) {
      existingHandles.forEach(h => h.remove());
    }

    // Image link button: only show when selected AND has a link
    if (htmlEl.classList.contains('item-image') && findItem) {
      const existingBtn = htmlEl.querySelector('.image-link-btn');
      if (isSelected && !existingBtn) {
        const item = findItem(id);
        if (item?.sourceUrl) {
          const linkBtn = document.createElement('button');
          linkBtn.className = 'image-link-btn has-link';
          linkBtn.title = `Link: ${item.sourceUrl}`;
          linkBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>';
          linkBtn.dataset.action = 'image-link';
          htmlEl.appendChild(linkBtn);
        }
      } else if (!isSelected && existingBtn) {
        existingBtn.remove();
      }
    }
  }
}

export function updateItemPosition(
  layer: HTMLElement,
  id: string,
  x: number,
  y: number
): void {
  const el = layer.querySelector(`[data-item-id="${id}"]`) as HTMLElement | null;
  if (el) {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }
}

export function updateItemSize(
  layer: HTMLElement,
  id: string,
  w: number,
  h: number
): void {
  const el = layer.querySelector(`[data-item-id="${id}"]`) as HTMLElement | null;
  if (el) {
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
  }
}

// ── Context Menu ──

export interface ContextMenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
  /** When true, renders a visual separator line before this item */
  separator?: boolean;
}

let _ctxCleanup: (() => void) | null = null;

export function closeContextMenu(): void {
  if (_ctxCleanup) {
    _ctxCleanup();
    _ctxCleanup = null;
  }
}

export function showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-sep';
      menu.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.className = `context-menu-item${item.danger ? ' danger' : ''}`;
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      closeContextMenu();
      item.action();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  // Adjust if off-screen
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 8}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${window.innerHeight - rect.height - 8}px`;
    }
  });

  const outsideListener = (e: MouseEvent) => {
    if (!menu.contains(e.target as HTMLElement)) {
      closeContextMenu();
    }
  };

  setTimeout(() => {
    window.addEventListener('mousedown', outsideListener, true);
  }, 0);

  _ctxCleanup = () => {
    menu.remove();
    window.removeEventListener('mousedown', outsideListener, true);
  };
}

// ── Home Screen ──

function formatRelativeDate(ts: number): string {
  const diff = Date.now() - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'agora';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}min atrás`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h atrás`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d atrás`;
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

export interface HomeCallbacks {
  onOpenBoard: (boardId: string) => void;
  onNewBoard: () => void;
  onDeleteBoard: (boardId: string) => void;
  onArchiveBoard: (boardId: string) => void;
  onRenameBoard: (boardId: string, name: string) => void;
  onUpdateDescription: (boardId: string, desc: string) => void;
  onToggleTheme: () => void;
}

export function renderHome(
  container: HTMLElement,
  boards: Board[],
  cb: HomeCallbacks
): void {
  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'home-container';

  // Header
  const header = document.createElement('div');
  header.className = 'home-header';

  const title = document.createElement('h1');
  title.className = 'home-title';
  title.textContent = 'Moodboard';

  const newBtn = document.createElement('button');
  newBtn.className = 'home-new-btn';
  newBtn.textContent = '+ Novo board';
  newBtn.addEventListener('click', cb.onNewBoard);

  const headerRight = document.createElement('div');
  headerRight.style.display = 'flex';
  headerRight.style.alignItems = 'center';
  headerRight.style.gap = '12px';

  const homeThemeBtn = document.createElement('button');
  homeThemeBtn.className = 'home-theme-btn';
  homeThemeBtn.title = 'Alternar tema claro/escuro';
  const sunP = 'M12 3v1m0 16v1m-8-9H3m18 0h-1m-2.636-6.364l-.707.707M6.343 17.657l-.707.707m0-12.728l.707.707m11.314 11.314l.707.707 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z';
  const moonP = 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z';
  const isDarkHome = document.documentElement.getAttribute('data-theme') === 'dark';
  homeThemeBtn.innerHTML = svgEl(isDarkHome ? sunP : moonP);
  homeThemeBtn.addEventListener('click', () => {
    cb.onToggleTheme();
    const nowDark = document.documentElement.getAttribute('data-theme') === 'dark';
    homeThemeBtn.innerHTML = svgEl(nowDark ? sunP : moonP);
  });

  headerRight.append(newBtn, homeThemeBtn);
  header.append(title, headerRight);
  wrapper.appendChild(header);

  // Search
  const controls = document.createElement('div');
  controls.className = 'home-controls';

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'home-search';
  searchInput.placeholder = 'Buscar boards…';
  controls.appendChild(searchInput);
  wrapper.appendChild(controls);

  // Active boards grid
  const activeGrid = document.createElement('div');
  activeGrid.className = 'home-grid';
  wrapper.appendChild(activeGrid);

  // Archived section
  const archivedSection = document.createElement('div');
  archivedSection.className = 'home-archived-section';

  const archivedToggle = document.createElement('button');
  archivedToggle.className = 'home-archived-toggle';
  archivedSection.appendChild(archivedToggle);

  const archivedGrid = document.createElement('div');
  archivedGrid.className = 'home-grid';
  archivedGrid.style.display = 'none';
  archivedSection.appendChild(archivedGrid);

  wrapper.appendChild(archivedSection);
  container.appendChild(wrapper);

  let searchQuery = '';
  let archivedOpen = false;

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.toLowerCase();
    renderCards();
  });

  archivedToggle.addEventListener('click', () => {
    archivedOpen = !archivedOpen;
    archivedGrid.style.display = archivedOpen ? '' : 'none';
    updateArchivedLabel();
  });

  function updateArchivedLabel() {
    const count = boards.filter(b => b.archived && !b.isSubBoard).length;
    archivedToggle.textContent = `Arquivados (${count}) ${archivedOpen ? '▾' : '▸'}`;
  }

  function filterBoards(list: Board[]): Board[] {
    if (!searchQuery) return list;
    return list.filter(b =>
      b.name.toLowerCase().includes(searchQuery) ||
      (b.description || '').toLowerCase().includes(searchQuery)
    );
  }

  function createBoardCard(board: Board): HTMLElement {
    const card = document.createElement('div');
    card.className = 'board-card';
    card.addEventListener('click', () => cb.onOpenBoard(board.id));

    const name = document.createElement('div');
    name.className = 'board-card-name';
    name.textContent = board.name || 'Sem título';

    const desc = document.createElement('div');
    desc.className = `board-card-desc${board.description ? '' : ' empty'}`;
    desc.textContent = board.description || 'Sem descrição';

    const meta = document.createElement('div');
    meta.className = 'board-card-meta';

    const itemCount = document.createElement('span');
    itemCount.textContent = `${board.items.length} ${board.items.length === 1 ? 'item' : 'itens'}`;

    const dateSpan = document.createElement('span');
    dateSpan.textContent = formatRelativeDate(board.updatedAt || board.createdAt);

    meta.append(itemCount, dateSpan);
    card.append(name, desc, meta);

    // Context menu
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const menuItems: ContextMenuItem[] = [];

      menuItems.push({
        label: 'Renomear',
        action: () => {
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'board-card-name-input';
          input.value = board.name;
          name.replaceWith(input);
          input.focus();
          input.select();

          input.addEventListener('click', (ev) => ev.stopPropagation());
          input.addEventListener('mousedown', (ev) => ev.stopPropagation());

          const commitRename = () => {
            const val = input.value.trim() || 'Sem título';
            name.textContent = val;
            input.replaceWith(name);
            cb.onRenameBoard(board.id, val);
          };
          input.addEventListener('blur', commitRename);
          input.addEventListener('keydown', (ke) => {
            if (ke.key === 'Enter') input.blur();
            if (ke.key === 'Escape') { input.value = board.name; input.blur(); }
            ke.stopPropagation();
          });
        }
      });

      menuItems.push({
        label: 'Editar descrição',
        action: () => {
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'board-card-desc-input';
          input.value = board.description || '';
          input.placeholder = 'Adicionar descrição…';
          desc.replaceWith(input);
          input.focus();

          input.addEventListener('click', (ev) => ev.stopPropagation());
          input.addEventListener('mousedown', (ev) => ev.stopPropagation());

          const commitDesc = () => {
            const val = input.value.trim();
            desc.textContent = val || 'Sem descrição';
            desc.className = `board-card-desc${val ? '' : ' empty'}`;
            input.replaceWith(desc);
            cb.onUpdateDescription(board.id, val);
          };
          input.addEventListener('blur', commitDesc);
          input.addEventListener('keydown', (ke) => {
            if (ke.key === 'Enter') input.blur();
            if (ke.key === 'Escape') { input.value = board.description || ''; input.blur(); }
            ke.stopPropagation();
          });
        }
      });

      if (board.archived) {
        menuItems.push({ label: 'Desarquivar', action: () => cb.onArchiveBoard(board.id) });
      } else {
        menuItems.push({ label: 'Arquivar', action: () => cb.onArchiveBoard(board.id) });
      }

      if (boards.length > 1) {
        menuItems.push({
          label: 'Excluir',
          action: () => {
            if (confirm(`Excluir "${board.name}"?`)) {
              cb.onDeleteBoard(board.id);
            }
          },
          danger: true
        });
      }

      showContextMenu(e.clientX, e.clientY, menuItems);
    });

    return card;
  }

  function renderCards() {
    // Sub-boards are embedded inside board items — never shown on the home list
    const topLevel = boards.filter(b => !b.isSubBoard);
    const active = topLevel.filter(b => !b.archived);
    const archived = topLevel.filter(b => b.archived);

    const sortedActive = filterBoards([...active]).sort(
      (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
    );
    const sortedArchived = filterBoards([...archived]).sort(
      (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
    );

    activeGrid.innerHTML = '';
    if (sortedActive.length === 0 && !searchQuery) {
      const empty = document.createElement('div');
      empty.className = 'home-empty';
      empty.textContent = 'Nenhum board ativo. Crie um novo!';
      activeGrid.appendChild(empty);
    } else {
      for (const board of sortedActive) {
        activeGrid.appendChild(createBoardCard(board));
      }
    }

    archivedSection.style.display = archived.length > 0 ? '' : 'none';
    updateArchivedLabel();

    archivedGrid.innerHTML = '';
    for (const board of sortedArchived) {
      archivedGrid.appendChild(createBoardCard(board));
    }
  }

  renderCards();
}
