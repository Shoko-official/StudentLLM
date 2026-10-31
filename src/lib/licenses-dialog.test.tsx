import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LicensesDialog } from './licenses-dialog';

describe('LicensesDialog', () => {
  it('shows the bundled licence, notices and component list without any network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onClose = vi.fn();
    render(<LicensesDialog onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: 'Open-source licences' })).toBeInTheDocument();
    expect(await screen.findByText(/Permission is hereby granted, free of charge/)).toBeInTheDocument();
    expect(screen.getByText(/Third-party notices/, { selector: 'summary' })).toBeInTheDocument();
    expect(screen.getByText(/Open-source components/, { selector: 'summary' })).toBeInTheDocument();
    expect(screen.getAllByText(/MPL-2\.0/).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Close licences' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});
