import { useEffect, useRef, useState } from 'react';
import { coachDimmed, type PointMarkBoard } from './coach';

const CHECK_MS = 100;

export function CoachBox({ text, marks }: { text: string; marks: PointMarkBoard }) {
  const box = useRef<HTMLDivElement>(null);
  const [dimmed, setDimmed] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setDimmed(coachDimmed(box.current?.getBoundingClientRect(), marks, performance.now())), CHECK_MS);
    return () => clearInterval(id);
  }, [marks]);
  return <div ref={box} className={dimmed ? 'coach dimmed' : 'coach'}>{text}</div>;
}
