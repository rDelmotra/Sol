import type { DsoProvider } from '@orbitwatch/contracts';
import type { DsoProviderAdapter } from './types.js';
import { HorizonsProvider } from './horizons.js';

const horizonsProvider = new HorizonsProvider();

export function getDsoProviderAdapter(provider: DsoProvider): DsoProviderAdapter {
  switch (provider) {
    case 'horizons':
      return horizonsProvider;
    case 'spice':
      throw new Error('SPICE provider adapter is not implemented yet');
  }
}
