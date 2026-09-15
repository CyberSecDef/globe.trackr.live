/**
 * Köppen-Geiger climate classes, 1991-2020, from Beck et al. 2023.
 *
 * Index matches the B channel of earth-regions.png; 0 means "no class here",
 * which is every ocean pixel. Colours are the ones used in the paper, so a
 * screenshot of the climate view is directly comparable to the published map.
 *
 * The maps are CC BY-NC 4.0. Cite Beck et al., Scientific Data 10, 724 (2023).
 */
export const KOPPEN = [
  null,
  { code: 'Af',  color: 0x0000ff, group: 'Tropical', label: 'Tropical rainforest' },
  { code: 'Am',  color: 0x0078ff, group: 'Tropical', label: 'Tropical monsoon' },
  { code: 'Aw',  color: 0x46aafa, group: 'Tropical', label: 'Tropical savannah' },
  { code: 'BWh', color: 0xff0000, group: 'Arid',     label: 'Hot desert' },
  { code: 'BWk', color: 0xff9696, group: 'Arid',     label: 'Cold desert' },
  { code: 'BSh', color: 0xf5a500, group: 'Arid',     label: 'Hot steppe' },
  { code: 'BSk', color: 0xffdc64, group: 'Arid',     label: 'Cold steppe' },
  { code: 'Csa', color: 0xffff00, group: 'Temperate', label: 'Mediterranean, hot summer' },
  { code: 'Csb', color: 0xc8c800, group: 'Temperate', label: 'Mediterranean, warm summer' },
  { code: 'Csc', color: 0x969600, group: 'Temperate', label: 'Mediterranean, cold summer' },
  { code: 'Cwa', color: 0x96ff96, group: 'Temperate', label: 'Dry winter, hot summer' },
  { code: 'Cwb', color: 0x64c864, group: 'Temperate', label: 'Dry winter, warm summer' },
  { code: 'Cwc', color: 0x329632, group: 'Temperate', label: 'Dry winter, cold summer' },
  { code: 'Cfa', color: 0xc8ff50, group: 'Temperate', label: 'Humid subtropical' },
  { code: 'Cfb', color: 0x64ff50, group: 'Temperate', label: 'Oceanic' },
  { code: 'Cfc', color: 0x32c800, group: 'Temperate', label: 'Subpolar oceanic' },
  { code: 'Dsa', color: 0xff00ff, group: 'Continental', label: 'Dry summer, hot summer' },
  { code: 'Dsb', color: 0xc800c8, group: 'Continental', label: 'Dry summer, warm summer' },
  { code: 'Dsc', color: 0x963296, group: 'Continental', label: 'Dry summer, cold summer' },
  { code: 'Dsd', color: 0x966496, group: 'Continental', label: 'Dry summer, very cold winter' },
  { code: 'Dwa', color: 0xaaafff, group: 'Continental', label: 'Dry winter, hot summer' },
  { code: 'Dwb', color: 0x5a78dc, group: 'Continental', label: 'Dry winter, warm summer' },
  { code: 'Dwc', color: 0x4b50b4, group: 'Continental', label: 'Dry winter, cold summer' },
  { code: 'Dwd', color: 0x320087, group: 'Continental', label: 'Dry winter, very cold winter' },
  { code: 'Dfa', color: 0x00ffff, group: 'Continental', label: 'Humid continental, hot summer' },
  { code: 'Dfb', color: 0x37c8ff, group: 'Continental', label: 'Humid continental, warm summer' },
  { code: 'Dfc', color: 0x007d7d, group: 'Continental', label: 'Subarctic' },
  { code: 'Dfd', color: 0x00465f, group: 'Continental', label: 'Extremely cold subarctic' },
  { code: 'ET',  color: 0xb2b2b2, group: 'Polar', label: 'Tundra' },
  { code: 'EF',  color: 0x666666, group: 'Polar', label: 'Ice cap' },
]

export function koppenLabel(index) {
  const k = KOPPEN[index]
  return k ? `${k.code} — ${k.label}` : null
}
