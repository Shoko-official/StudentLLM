import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

type Notices = { title: string; text: string }[];

// The notices live in the repository root. They are loaded on demand, as separate chunks, so the app never fetches
// them over the network and the packaged app can show them offline.
async function loadNotices(): Promise<Notices> {
  const [license, notice, third] = await Promise.all([
    import('../../LICENSE?raw'),
    import('../../NOTICE.md?raw'),
    import('../../THIRD_PARTY_LICENSES.md?raw'),
  ]);
  return [
    { title: 'StudentLLM licence', text: license.default },
    { title: 'Third-party notices', text: notice.default },
    { title: 'Open-source components', text: third.default },
  ];
}

export function LicensesDialog({ onClose }: { onClose: () => void }) {
  const [notices, setNotices] = useState<Notices | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    loadNotices().then((loaded) => { if (active) setNotices(loaded); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal licenses-modal" role="dialog" aria-modal="true" aria-labelledby="licenses-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div><span className="section-kicker">About</span><h2 id="licenses-title">Open-source licences</h2></div>
          <button className="icon-button" aria-label="Close licences" onClick={onClose}><X size={17} /></button>
        </div>
        <p className="modal-description">
          StudentLLM is MIT licensed and built on open-source software that keeps its own licences. The same notices are in
          the <code>licenses</code> folder of the installed application, and the complete licence text of every component is
          attached to each release on the project page.
        </p>
        {failed && <p className="empty-state" role="alert">The notices could not be loaded.</p>}
        {!notices && !failed && <p className="empty-state" aria-live="polite">Loading notices…</p>}
        {notices?.map((notice) => (
          <details key={notice.title} className="license-section" open={notice.title !== 'Open-source components'}>
            <summary>{notice.title}</summary>
            <pre className="license-text" tabIndex={0}>{notice.text}</pre>
          </details>
        ))}
        <div className="modal-footer"><button type="button" className="primary-submit" onClick={onClose}>Done</button></div>
      </section>
    </div>
  );
}
