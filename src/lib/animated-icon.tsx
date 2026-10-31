import { FileText, FolderOpen, Mic, Pencil, Search, Star } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// Lucide icons (ISC licence) with a small CSS animation. Everything is bundled locally and the
// motion collapses under prefers-reduced-motion (see styles.css).
const icons: Record<string, LucideIcon> = {
  'file-text': FileText,
  folder: FolderOpen,
  magnifier: Search,
  microphone: Mic,
  pencil: Pencil,
  star: Star,
};

export type AnimatedIconName = 'file-text' | 'folder' | 'magnifier' | 'microphone' | 'pencil' | 'star';

type AnimatedIconProps = {
  name: AnimatedIconName;
  size?: number;
  /** Play a short reveal when the icon first appears. */
  intro?: boolean;
  className?: string;
};

/** A decorative icon that nudges when an ancestor button is hovered or focused. */
export function AnimatedIcon({ name, size = 24, intro = false, className }: AnimatedIconProps) {
  const Icon = icons[name];
  const classes = ['animated-icon', intro ? 'animated-icon-intro' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <span className={classes} style={{ width: size, height: size }} aria-hidden="true">
      <Icon size={size} strokeWidth={1.75} />
    </span>
  );
}

/** A large icon on a soft badge, for empty states. */
export function EmptyStateIcon({ name }: { name: AnimatedIconName }) {
  return (
    <span className="empty-icon" aria-hidden="true">
      <AnimatedIcon name={name} size={44} intro />
    </span>
  );
}
