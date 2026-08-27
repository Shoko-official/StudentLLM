import { beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

describe('StudentLLM workspace', () => {
  beforeEach(() => localStorage.clear());

  it('renders the course workspace with sources and Studio actions', () => {
    render(<App />);

    expect(screen.getAllByText('Attention & Scaled Dot-Product').length).toBeGreaterThan(0);
    expect(screen.getByRole('complementary', { name: 'Navigation des cours' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Studio du cours' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /QCM ciblé/ })).toBeInTheDocument();
    expect(screen.getByText('transcription.txt')).toBeInTheDocument();
  });

  it('changes the active course from the navigation tree', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /Matrices et applications linéaires/ }));

    expect(screen.getAllByRole('heading', { name: 'Matrices et applications linéaires' }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Camille Roux/).length).toBeGreaterThan(0);
  });

  it('creates a new course from the keyboard-accessible modal', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /Nouveau cours/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Titre du cours'), 'Systèmes distribués');
    await user.click(screen.getByRole('button', { name: /Créer et préparer/ }));

    expect(screen.getAllByRole('heading', { name: 'Systèmes distribués' }).length).toBeGreaterThan(0);
    expect(screen.getByText('Nouveau cours créé. Prêt à enregistrer.')).toBeInTheDocument();
  });

  it('adds a generated artifact to the Studio', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /Fiche de révision/ }));

    const recent = screen.getByText('Récemment créé').parentElement?.parentElement;
    expect(recent).toBeTruthy();
    expect(within(recent as HTMLElement).getByText('Fiche de révision')).toBeInTheDocument();
  });

  it('switches to chat and sends a grounded question', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('tab', { name: /Chat/ }));
    const input = screen.getByLabelText('Poser une question au chat');
    await user.type(input, 'Peux-tu donner un exemple ?');
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));

    expect(screen.getByText('Peux-tu donner un exemple ?')).toBeInTheDocument();
    expect(screen.getByText('Je vais chercher dans les sources du cours et afficher les passages utilisés pour répondre.')).toBeInTheDocument();
  });

  it('records a bookmark and exposes a review segment', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Marquer ce passage' }));

    expect(screen.getByText('Point marqué par l’étudiant: à revoir dans le cours.')).toBeInTheDocument();
    expect(screen.getByText(/Point marqué à/)).toBeInTheDocument();
  });

  it('restores a created course after remounting the workspace', async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);

    await user.click(screen.getByRole('button', { name: /Nouveau cours/ }));
    await user.type(screen.getByLabelText('Titre du cours'), 'Cours persistant');
    await user.click(screen.getByRole('button', { name: /Créer et préparer/ }));
    firstRender.unmount();

    render(<App />);

    expect(screen.getAllByRole('heading', { name: 'Cours persistant' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('Nouveau cours créé. Prêt à enregistrer.')).not.toBeInTheDocument();
  });
});
