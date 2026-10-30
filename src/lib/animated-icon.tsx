import { lazy, ReactNode, Suspense } from 'react';
import fileTextIcon from '../assets/lordicon/file-text.json?url';
import folderIcon from '../assets/lordicon/folder.json?url';
import magnifierIcon from '../assets/lordicon/magnifier.json?url';
import microphoneIcon from '../assets/lordicon/microphone.json?url';
import pencilIcon from '../assets/lordicon/pencil.json?url';
import starIcon from '../assets/lordicon/star.json?url';

// The Lottie player is split into its own chunk; a static icon shows until it loads.
const LordIcon = lazy(() => import('@lordicon/react').then(({ LordIcon: Icon }) => ({ default: Icon })));

// Bundled locally so local mode never fetches icons from a CDN.
const icons = {
  'file-text': fileTextIcon,
  folder: folderIcon,
  magnifier: magnifierIcon,
  microphone: microphoneIcon,
  pencil: pencilIcon,
  star: starIcon,
} as const;

export type AnimatedIconName = keyof typeof icons;

type AnimatedIconProps = {
  name: AnimatedIconName;
  size?: number;
  /** Lordicon trigger, e.g. `hover` or `loop(4000)`. */
  trigger?: string;
  /** Ancestor selector whose hover/focus plays the icon, e.g. `button`. */
  target?: string;
  state?: string;
  intro?: string;
  className?: string;
  /** Static icon shown until the animated player has loaded. */
  fallback?: ReactNode;
};

export function AnimatedIcon({ name, size = 24, trigger = 'hover', target, state, intro, className, fallback }: AnimatedIconProps) {
  const classes = className ? `animated-icon ${className}` : 'animated-icon';
  const placeholder = <span className={classes} style={{ width: size, height: size }} aria-hidden="true">{fallback}</span>;
  return (
    <Suspense fallback={placeholder}>
      <LordIcon
        src={icons[name]}
        trigger={trigger}
        target={target}
        state={state}
        intro={intro}
        currentColor
        className={classes}
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
    </Suspense>
  );
}

/** A large animated icon on a soft badge, for empty states. */
export function EmptyStateIcon({ name, state }: { name: AnimatedIconName; state?: string }) {
  return (
    <span className="empty-icon" aria-hidden="true">
      <AnimatedIcon name={name} size={44} target=".empty-icon" state={state} intro="in-reveal" />
    </span>
  );
}
