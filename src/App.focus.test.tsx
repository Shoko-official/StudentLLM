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

describe('course actions menu and dialog focus', () => {
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

  it('focuses the first form field of Edit course and restores focus to More on close', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: /Edit course/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit course' });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).not.toHaveAccessibleName('Close edit course');
    expect(screen.getByLabelText('Course title')).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(moreButton()).toHaveFocus();
  });

  it('restores focus to More after cancelling Delete course', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: /Delete course/ }));

    const dialog = await screen.findByRole('dialog');
    expect(document.activeElement).not.toHaveAccessibleName('Close');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(moreButton()).toHaveFocus();
  });

  it('puts focus in the search field for Global search and restores the sidebar trigger', async () => {
    const user = userEvent.setup();
    render(<App />);
    const trigger = screen.getAllByRole('button', { name: /search/i }).find((button) => !button.closest('[role="dialog"]'))!;
    trigger.focus();
    await user.keyboard('{Enter}');

    const input = await screen.findByRole('textbox', { name: 'Search all course content' });
    expect(input).toHaveFocus();
    await user.keyboard('attention');
    expect(input).toHaveValue('attention');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('focuses the title field of New course and restores focus to its trigger', async () => {
    const user = userEvent.setup();
    render(<App />);
    const trigger = screen.getAllByRole('button', { name: /new course/i }).find((button) => !button.closest('[role="dialog"]'))!;
    await user.click(trigger);

    expect(await screen.findByLabelText('Course title')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
  });
});
