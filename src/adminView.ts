import type { Profile, Board } from './types';
import { createUser, updateProfile, getAllProfiles } from './auth';
import {
  getBoardAccess,
  setBoardAccess,
  removeBoardAccess,
  getAccessForProfile,
  type BoardAccessEntry,
} from './boardStore';

interface AdminCallbacks {
  onClose: () => void;
  getBoards: () => Board[];
}

export function renderAdmin(
  container: HTMLElement,
  cb: AdminCallbacks
): void {
  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'admin-wrapper';

  // Header
  const header = document.createElement('div');
  header.className = 'admin-header';
  const title = document.createElement('h2');
  title.textContent = 'Gerenciar Usuarios';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'admin-close-btn';
  closeBtn.innerHTML = '&times;';
  closeBtn.addEventListener('click', cb.onClose);
  header.append(title, closeBtn);

  // Layout: sidebar (user list) + main panel
  const layout = document.createElement('div');
  layout.className = 'admin-layout';

  const sidebar = document.createElement('div');
  sidebar.className = 'admin-sidebar';

  const main = document.createElement('div');
  main.className = 'admin-main';

  layout.append(sidebar, main);
  wrapper.append(header, layout);
  container.append(wrapper);

  let profiles: Profile[] = [];
  let selectedProfileId: string | null = null;

  async function loadProfiles() {
    profiles = await getAllProfiles();
    renderSidebar();
  }

  function renderSidebar() {
    sidebar.innerHTML = '';

    const addBtn = document.createElement('button');
    addBtn.className = 'admin-add-btn';
    addBtn.textContent = '+ Novo usuario';
    addBtn.addEventListener('click', () => {
      selectedProfileId = null;
      renderCreateForm();
    });
    sidebar.append(addBtn);

    for (const p of profiles) {
      const item = document.createElement('div');
      item.className = 'admin-user-item' + (selectedProfileId === p.id ? ' active' : '');
      item.addEventListener('click', () => {
        selectedProfileId = p.id;
        renderSidebar();
        renderProfileDetail(p);
      });

      const avatar = document.createElement('div');
      avatar.className = 'admin-user-avatar';
      avatar.style.background = p.color;
      if (p.avatar_url) {
        avatar.style.backgroundImage = `url(${p.avatar_url})`;
        avatar.style.backgroundSize = 'cover';
      } else {
        avatar.textContent = (p.display_name || p.email)[0].toUpperCase();
      }

      const info = document.createElement('div');
      info.className = 'admin-user-info';
      const name = document.createElement('div');
      name.className = 'admin-user-name';
      name.textContent = p.display_name;
      if (p.is_admin) {
        const badge = document.createElement('span');
        badge.className = 'admin-badge';
        badge.textContent = 'admin';
        name.append(badge);
      }
      const email = document.createElement('div');
      email.className = 'admin-user-email';
      email.textContent = p.email;
      info.append(name, email);

      item.append(avatar, info);
      sidebar.append(item);
    }
  }

  function renderCreateForm() {
    main.innerHTML = '';

    const form = document.createElement('form');
    form.className = 'admin-form';

    const h3 = document.createElement('h3');
    h3.textContent = 'Criar novo usuario';

    const fields = [
      { label: 'E-mail', type: 'email', id: 'email', required: true },
      { label: 'Senha', type: 'password', id: 'password', required: true },
      { label: 'Nome de exibicao', type: 'text', id: 'displayName', required: true },
    ] as const;

    const inputs: Record<string, HTMLInputElement> = {};

    form.append(h3);
    for (const f of fields) {
      const label = document.createElement('label');
      label.className = 'admin-label';
      label.textContent = f.label;
      const input = document.createElement('input');
      input.type = f.type;
      input.className = 'admin-input';
      input.required = f.required;
      inputs[f.id] = input;
      form.append(label, input);
    }

    // Color picker
    const colorLabel = document.createElement('label');
    colorLabel.className = 'admin-label';
    colorLabel.textContent = 'Cor do avatar';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'admin-color-input';
    colorInput.value = randomColor();
    form.append(colorLabel, colorInput);

    const errorEl = document.createElement('div');
    errorEl.className = 'admin-error';

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'admin-submit-btn';
    submitBtn.textContent = 'Criar usuario';

    form.append(errorEl, submitBtn);
    main.append(form);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.textContent = '';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Criando...';

      const { error, userId } = await createUser(
        inputs.email.value.trim(),
        inputs.password.value,
        inputs.displayName.value.trim(),
        colorInput.value
      );

      if (error) {
        errorEl.textContent = error;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Criar usuario';
      } else {
        selectedProfileId = userId;
        await loadProfiles();
        const profile = profiles.find(p => p.id === userId);
        if (profile) renderProfileDetail(profile);
      }
    });
  }

  async function renderProfileDetail(profile: Profile) {
    main.innerHTML = '';

    const section = document.createElement('div');
    section.className = 'admin-detail';

    // Profile header
    const profileHeader = document.createElement('div');
    profileHeader.className = 'admin-detail-header';

    const avatar = document.createElement('div');
    avatar.className = 'admin-detail-avatar';
    avatar.style.background = profile.color;
    if (profile.avatar_url) {
      avatar.style.backgroundImage = `url(${profile.avatar_url})`;
      avatar.style.backgroundSize = 'cover';
    } else {
      avatar.textContent = (profile.display_name || profile.email)[0].toUpperCase();
    }

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'admin-input';
    nameInput.value = profile.display_name;

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'admin-color-input';
    colorInput.value = profile.color;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'admin-submit-btn small';
    saveBtn.textContent = 'Salvar perfil';
    saveBtn.addEventListener('click', async () => {
      await updateProfile(profile.id, {
        display_name: nameInput.value.trim(),
        color: colorInput.value,
      });
      await loadProfiles();
    });

    profileHeader.append(avatar, nameInput, colorInput, saveBtn);
    section.append(profileHeader);

    // Board access
    const accessTitle = document.createElement('h3');
    accessTitle.textContent = 'Acesso aos boards';
    accessTitle.style.marginTop = '24px';
    section.append(accessTitle);

    const boards = cb.getBoards();
    const access = await getAccessForProfile(profile.id);
    const accessMap = new Map(access.map(a => [a.board_id, a]));

    const boardList = document.createElement('div');
    boardList.className = 'admin-board-list';

    for (const board of boards) {
      const entry = accessMap.get(board.id);
      const row = document.createElement('div');
      row.className = 'admin-board-row';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'admin-board-name';
      nameSpan.textContent = board.name;

      const select = document.createElement('select');
      select.className = 'admin-role-select';
      select.innerHTML = `
        <option value="none">Sem acesso</option>
        <option value="viewer">Leitor</option>
        <option value="editor">Editor</option>
      `;
      select.value = entry?.role || 'none';

      select.addEventListener('change', async () => {
        if (select.value === 'none') {
          await removeBoardAccess(board.id, profile.id);
        } else {
          await setBoardAccess(board.id, profile.id, select.value as 'editor' | 'viewer');
        }
      });

      row.append(nameSpan, select);
      boardList.append(row);
    }

    section.append(boardList);
    main.append(section);
  }

  loadProfiles();
  renderCreateForm();
}

function randomColor(): string {
  const colors = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#d35400', '#16a085', '#2c3e50', '#e74c3c'];
  return colors[Math.floor(Math.random() * colors.length)];
}
