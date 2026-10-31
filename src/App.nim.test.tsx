import { afterEach, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { DEFAULT_NIM_MODEL } from './lib/nvidia-nim';
import { WORKSPACE_STORAGE_KEY } from './lib/workspace-storage';
import { createFixtureWorkspace } from './test/workspace-fixture';

const SERVICES_KEY = 'studentllm.services.v1';
const selected = 'fixture/selected-model';
const answer = () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
const modelFrom = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}')).model as string | undefined;
const localResponse = () => new Response(JSON.stringify({ data: [{ id: 'fixture/local-model' }] }));
const openSettings = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Settings' }));
  return screen.getByRole('dialog', { name: 'Settings' });
};

beforeEach(() => {
  vi.stubEnv('VITE_LM_STUDIO_AUTO_CONNECT', 'false');
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(createFixtureWorkspace()));
  localStorage.setItem(SERVICES_KEY, JSON.stringify({ llmProvider: 'nvidia-nim', nimModel: selected }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('waits for a final answer before calling a listed model connected', async () => {
  let reply!: (value: Response) => void;
  const completion = new Promise<Response>((resolve) => { reply = resolve; });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input).endsWith('/chat/completions')) return completion;
    return new Response(JSON.stringify({ data: [{ id: selected }] }));
  });
  const user = userEvent.setup();
  render(<App provider={null} />);
  const panel = await openSettings(user);
  await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/chat/completions'))).toBe(true));
  expect(within(panel).getByRole('status')).not.toHaveTextContent('Connected');
  await act(async () => { reply(answer()); });
  await waitFor(() => expect(within(panel).getByRole('status')).toHaveTextContent(`Connected. ${selected} answered`));
  const [, init] = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/chat/completions'))!;
  expect(JSON.parse(String(init?.body))).toMatchObject({ model: selected, max_tokens: 8, stream: false });
  expect(String(init?.body)).not.toContain('Scaled Dot');
  expect(within(panel).getByLabelText('NVIDIA model')).toHaveValue(selected);
});

it.each([404, 410, 504])('switches from a failed model only after the fallback answers (HTTP %s)', async (status) => {
  const tested: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).endsWith('/chat/completions')) {
      const model = modelFrom(init)!;
      tested.push(model);
      return model === selected ? new Response('{}', { status }) : answer();
    }
    return new Response(JSON.stringify({ data: [{ id: selected }, { id: DEFAULT_NIM_MODEL }] }));
  });
  const user = userEvent.setup();
  render(<App provider={null} />);
  const panel = await openSettings(user);
  await waitFor(() => expect(within(panel).getByRole('status')).toHaveTextContent('Switched'));
  expect(within(panel).getByRole('status')).toHaveTextContent('NVIDIA NIM: Connected.');
  expect(tested).toEqual([selected, DEFAULT_NIM_MODEL]);
  expect(within(panel).getByLabelText('NVIDIA model')).toHaveValue(DEFAULT_NIM_MODEL);
  expect(JSON.parse(localStorage.getItem(SERVICES_KEY)!)).toMatchObject({ nimModel: DEFAULT_NIM_MODEL });
});

it('keeps the selected model when the fallback cannot answer either', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).endsWith('/chat/completions')
    ? new Response('{}', { status: 410 }) : localResponse());
  const user = userEvent.setup();
  render(<App provider={null} />);
  const panel = await openSettings(user);
  await waitFor(() => expect(within(panel).getByRole('status')).not.toHaveTextContent('Checking'));
  expect(within(panel).getByRole('status')).not.toHaveTextContent('Connected');
  expect(within(panel).getByLabelText('NVIDIA model')).toHaveValue(selected);
  expect(JSON.parse(localStorage.getItem(SERVICES_KEY)!)).toMatchObject({ nimModel: selected });
});

it.each([401, 429])('does not try another model for credentials or quota errors (HTTP %s)', async (status) => {
  const tested: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).endsWith('/chat/completions')) { tested.push(modelFrom(init)!); return new Response('{}', { status }); }
    return localResponse();
  });
  const user = userEvent.setup();
  render(<App provider={null} />);
  const panel = await openSettings(user);
  await waitFor(() => expect(within(panel).getByRole('status')).not.toHaveTextContent('Checking'));
  expect(tested).toEqual([selected]);
  expect(within(panel).getByRole('status')).not.toHaveTextContent('Connected');
});

it('does not treat reasoning-only output as a working connection', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).endsWith('/chat/completions')
    ? new Response(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'Thinking' } }] }))
    : new Response(JSON.stringify({ data: [{ id: selected }] })));
  const user = userEvent.setup();
  render(<App provider={null} />);
  const panel = await openSettings(user);
  await waitFor(() => expect(within(panel).getByRole('status')).not.toHaveTextContent('Checking'));
  expect(within(panel).getByRole('status')).not.toHaveTextContent('Connected');
  expect(within(panel).getByLabelText('NVIDIA model')).toHaveValue(selected);
});

it('does not overwrite a newer connection check with an old fallback result', async () => {
  let finishOld!: (value: Response) => void;
  const oldResult = new Promise<Response>((resolve) => { finishOld = resolve; });
  let attempts = 0;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input).endsWith('/chat/completions')) return ++attempts === 1 ? oldResult : answer();
    return localResponse();
  });
  const user = userEvent.setup();
  render(<App provider={null} />);
  let panel = await openSettings(user);
  await waitFor(() => expect(attempts).toBe(1));
  await user.click(within(panel).getByRole('button', { name: 'Done' }));
  panel = await openSettings(user);
  await waitFor(() => expect(within(panel).getByRole('status')).toHaveTextContent(`Connected. ${selected} answered`));
  await act(async () => { finishOld(new Response('{}', { status: 410 })); });
  expect(within(panel).getByLabelText('NVIDIA model')).toHaveValue(selected);
  expect(JSON.parse(localStorage.getItem(SERVICES_KEY)!)).toMatchObject({ nimModel: selected });
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/chat/completions'))).toHaveLength(2);
});
