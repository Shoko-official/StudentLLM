import { afterEach, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { WORKSPACE_STORAGE_KEY } from './lib/workspace-storage';
import { createFixtureWorkspace } from './test/workspace-fixture';

type User = ReturnType<typeof userEvent.setup>;

const moreButton = () => screen.getByLabelText('Course actions');
const isMenuOpen = () => Boolean(moreButton().closest('details')?.open);
const openMenu = (user: User) => user.click(moreButton());

describe('course actions menu', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false');
    localStorage.clear();
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(createFixtureWorkspace()));
    localStorage.setItem('studentllm.recording-notice.v1', JSON.stringify({ version: 1, acknowledgedAt: new Date().toISOString() }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('closes the More menu on an outside pointerdown but not on a click inside it', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openMenu(user);
    expect(isMenuOpen()).toBe(true);

    await user.click(screen.getByRole('region', { name: 'Course notes document' }));
    expect(isMenuOpen()).toBe(false);
  });

  it('closes the More menu on Escape and returns focus to its button', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openMenu(user);
    await user.keyboard('{Escape}');

    expect(isMenuOpen()).toBe(false);
    expect(moreButton()).toHaveFocus();
  });

  it('closes the More menu when a modal opens from elsewhere', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: /settings/i }));

    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(isMenuOpen()).toBe(false);
  });
});
