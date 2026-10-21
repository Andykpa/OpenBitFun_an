import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const programmersDayEggAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'programmers-day-egg',
  parts: [
    { id: 'root' },
    { id: 'rain' },
    { id: 'anchor' },
    { id: 'badge' },
    { id: 'bracket', visualRole: 'content' },
    { id: 'value', visualRole: 'content' },
    { id: 'cursor' },
    { id: 'burst' },
    { id: 'particle', visualRole: 'content' },
  ],
  states: [
    { id: 'decoding', selector: { kind: 'self', suffix: '[data-openbitfun-state~="decoding"]' } },
    { id: 'clipped', selector: { kind: 'self', suffix: '[data-openbitfun-state~="clipped"]' } },
    { id: 'glitching', selector: { kind: 'self', suffix: '[data-openbitfun-state~="glitching"]' } },
  ],
};
