import { createContext, useContext } from 'react';
import { LoaderCircle, RotateCcw } from 'lucide-react';
import { parseVisualBrief } from './visual-brief';
import './teaching-visual-view.css';

export interface VisualJobControls {
  isPending: (messageId: string, briefId: string) => boolean;
  retry?: (messageId: string, briefId: string) => void;
}

export const VisualJobsContext = createContext<VisualJobControls | null>(null);

export function VisualRequestView({ raw, messageId }: { raw: string; messageId?: string }) {
  const controls = useContext(VisualJobsContext);
  const brief = parseVisualBrief(raw);
  if (!brief) return <p className="teaching-visual-request"><span>This visual was not generated.</span></p>;
  if (messageId !== undefined && controls?.isPending(messageId, brief.id)) {
    return <p className="teaching-visual-request" role="status"><LoaderCircle size={15} aria-hidden="true" /><span>Preparing a visual: {brief.intent}</span></p>;
  }
  return <div className="teaching-visual-request">
    <span>This visual was not generated: {brief.intent}</span>
    {messageId !== undefined && controls?.retry && <button type="button" className="text-action" onClick={() => controls.retry!(messageId, brief.id)}><RotateCcw size={14} aria-hidden="true" /> Retry this visual</button>}
  </div>;
}
