import { signIn } from './auth';

export function renderLogin(
  container: HTMLElement,
  onSuccess: () => void
): void {
  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'login-wrapper';

  const card = document.createElement('div');
  card.className = 'login-card';

  const title = document.createElement('h1');
  title.className = 'login-title';
  title.textContent = 'Moodboard';

  const subtitle = document.createElement('p');
  subtitle.className = 'login-subtitle';
  subtitle.textContent = 'Faça login para continuar';

  const form = document.createElement('form');
  form.className = 'login-form';

  const emailLabel = document.createElement('label');
  emailLabel.className = 'login-label';
  emailLabel.textContent = 'E-mail';
  const emailInput = document.createElement('input');
  emailInput.type = 'email';
  emailInput.className = 'login-input';
  emailInput.placeholder = 'seu@email.com';
  emailInput.required = true;
  emailInput.autocomplete = 'email';

  const passLabel = document.createElement('label');
  passLabel.className = 'login-label';
  passLabel.textContent = 'Senha';
  const passInput = document.createElement('input');
  passInput.type = 'password';
  passInput.className = 'login-input';
  passInput.placeholder = '••••••••';
  passInput.required = true;
  passInput.autocomplete = 'current-password';

  const errorEl = document.createElement('div');
  errorEl.className = 'login-error';

  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.className = 'login-btn';
  btn.textContent = 'Entrar';

  form.append(emailLabel, emailInput, passLabel, passInput, errorEl, btn);
  card.append(title, subtitle, form);
  wrapper.append(card);
  container.append(wrapper);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Entrando...';

    const { error } = await signIn(emailInput.value.trim(), passInput.value);
    if (error) {
      errorEl.textContent = error;
      btn.disabled = false;
      btn.textContent = 'Entrar';
    } else {
      onSuccess();
    }
  });

  emailInput.focus();
}
