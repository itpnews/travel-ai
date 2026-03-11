import type {
  Hub, CountryRisk, SafeModeConfig,
  SearchMode, SearchModeConfig,
  VisaRule, TransitRule, CountryAccessRule,
} from './index.js';

// ─── Routing Constraints ──────────────────────────────────────────────────────

export const ROUTING_CONSTRAINTS = {
  // Provider call budget
  maxProviderCallsPerSearch: 20,    // hard cap; cache hits do NOT count
  parallelProviderRequests: 3,      // concurrency via p-limit

  // Route thresholds
  minProviderRoutesBeforeFallback: 5,
  minRoutesForEarlyExit: 10,

  // Flight structure
  maxFlightSegments: 4,             // hard filter
  maxTotalDurationHours: 72,        // hard filter (soft penalty at 48h)

  // Fallback
  maxFallbackDepth: 1,              // depth-1 only in v0.5; depth-2 deferred to v1
  maxHubCandidatesPerDepth: 5,
  maxFallbackRoutes: 10,

  // Date window
  flexDateWindowDays: 3,            // ±3 days

  // Results
  maxRoutesReturned: 20,

  // Cache
  cacheTTLSeconds: 300,             // 5 minutes

  // Budget bands (multipliers over cheapest)
  budgetBandBalanced: 1.25,
  budgetBandFlexible: 1.50,
} as const;

// ─── Hub Pool ─────────────────────────────────────────────────────────────────
// ~20 globally stable hubs; stabilityScore sourced from OurAirports + IATA data

export const HUB_POOL: Hub[] = [
  // Europe
  { iata: 'LHR', name: 'London Heathrow',         region: 'europe',        stabilityScore: 0.92, lat: 51.4775,  lng: -0.4614  },
  { iata: 'CDG', name: 'Paris Charles de Gaulle',  region: 'europe',        stabilityScore: 0.90, lat: 49.0097,  lng: 2.5479   },
  { iata: 'AMS', name: 'Amsterdam Schiphol',       region: 'europe',        stabilityScore: 0.93, lat: 52.3086,  lng: 4.7639   },
  { iata: 'FRA', name: 'Frankfurt Airport',        region: 'europe',        stabilityScore: 0.91, lat: 50.0379,  lng: 8.5622   },
  { iata: 'MAD', name: 'Madrid Barajas',           region: 'europe',        stabilityScore: 0.87, lat: 40.4936,  lng: -3.5668  },
  { iata: 'ZRH', name: 'Zurich Airport',           region: 'europe',        stabilityScore: 0.94, lat: 47.4647,  lng: 8.5492   },
  { iata: 'VIE', name: 'Vienna International',     region: 'europe',        stabilityScore: 0.89, lat: 48.1102,  lng: 16.5697  },
  // North America
  { iata: 'JFK', name: 'New York JFK',             region: 'north_america', stabilityScore: 0.85, lat: 40.6413,  lng: -73.7781 },
  { iata: 'ORD', name: 'Chicago O\'Hare',          region: 'north_america', stabilityScore: 0.83, lat: 41.9742,  lng: -87.9073 },
  { iata: 'ATL', name: 'Atlanta Hartsfield',       region: 'north_america', stabilityScore: 0.86, lat: 33.6407,  lng: -84.4277 },
  { iata: 'LAX', name: 'Los Angeles International',region: 'north_america', stabilityScore: 0.84, lat: 33.9425,  lng: -118.408 },
  { iata: 'YYZ', name: 'Toronto Pearson',          region: 'north_america', stabilityScore: 0.87, lat: 43.6772,  lng: -79.6306 },
  // Middle East
  { iata: 'DXB', name: 'Dubai International',      region: 'middle_east',   stabilityScore: 0.93, lat: 25.2532,  lng: 55.3657  },
  { iata: 'DOH', name: 'Hamad International',      region: 'middle_east',   stabilityScore: 0.92, lat: 25.2609,  lng: 51.6138  },
  // Asia-Pacific
  { iata: 'SIN', name: 'Singapore Changi',         region: 'asia_pacific',  stabilityScore: 0.96, lat: 1.3644,   lng: 103.9915 },
  { iata: 'HKG', name: 'Hong Kong International',  region: 'asia_pacific',  stabilityScore: 0.90, lat: 22.308,   lng: 113.9185 },
  { iata: 'NRT', name: 'Tokyo Narita',             region: 'asia_pacific',  stabilityScore: 0.91, lat: 35.7647,  lng: 140.3864 },
  { iata: 'SYD', name: 'Sydney Kingsford Smith',   region: 'asia_pacific',  stabilityScore: 0.88, lat: -33.9399, lng: 151.1753 },
  // South America
  { iata: 'GRU', name: 'São Paulo Guarulhos',      region: 'south_america', stabilityScore: 0.82, lat: -23.4356, lng: -46.4731 },
  // Africa
  { iata: 'JNB', name: 'Johannesburg O.R. Tambo',  region: 'africa',        stabilityScore: 0.83, lat: -26.1367, lng: 28.2411  },
];

// ─── Country Risks ────────────────────────────────────────────────────────────
// riskScore: operational disruption risk (weather, ATC, infrastructure) 0..1
// visaComplexityScore: complexity for most passport holders 0..1

export const COUNTRY_RISKS: CountryRisk[] = [
  // Low risk
  { isoCode: 'AU', riskScore: 0.10, visaComplexityScore: 0.20 },
  { isoCode: 'AT', riskScore: 0.08, visaComplexityScore: 0.10 },
  { isoCode: 'BE', riskScore: 0.10, visaComplexityScore: 0.10 },
  { isoCode: 'CA', riskScore: 0.10, visaComplexityScore: 0.15 },
  { isoCode: 'CZ', riskScore: 0.10, visaComplexityScore: 0.10 },
  { isoCode: 'DK', riskScore: 0.08, visaComplexityScore: 0.10 },
  { isoCode: 'FI', riskScore: 0.08, visaComplexityScore: 0.10 },
  { isoCode: 'FR', riskScore: 0.18, visaComplexityScore: 0.12 },
  { isoCode: 'DE', riskScore: 0.10, visaComplexityScore: 0.10 },
  { isoCode: 'HK', riskScore: 0.15, visaComplexityScore: 0.25 },
  { isoCode: 'IE', riskScore: 0.12, visaComplexityScore: 0.10 },
  { isoCode: 'IT', riskScore: 0.20, visaComplexityScore: 0.12 },
  { isoCode: 'JP', riskScore: 0.25, visaComplexityScore: 0.20 },
  { isoCode: 'NL', riskScore: 0.10, visaComplexityScore: 0.10 },
  { isoCode: 'NZ', riskScore: 0.12, visaComplexityScore: 0.15 },
  { isoCode: 'NO', riskScore: 0.10, visaComplexityScore: 0.10 },
  { isoCode: 'PT', riskScore: 0.12, visaComplexityScore: 0.10 },
  { isoCode: 'SG', riskScore: 0.08, visaComplexityScore: 0.10 },
  { isoCode: 'KR', riskScore: 0.15, visaComplexityScore: 0.20 },
  { isoCode: 'ES', riskScore: 0.18, visaComplexityScore: 0.10 },
  { isoCode: 'SE', riskScore: 0.08, visaComplexityScore: 0.10 },
  { isoCode: 'CH', riskScore: 0.08, visaComplexityScore: 0.10 },
  { isoCode: 'GB', riskScore: 0.15, visaComplexityScore: 0.15 },
  { isoCode: 'US', riskScore: 0.15, visaComplexityScore: 0.30 },
  // Moderate risk
  { isoCode: 'AE', riskScore: 0.20, visaComplexityScore: 0.20 },
  { isoCode: 'AR', riskScore: 0.35, visaComplexityScore: 0.25 },
  { isoCode: 'BR', riskScore: 0.35, visaComplexityScore: 0.30 },
  { isoCode: 'CN', riskScore: 0.30, visaComplexityScore: 0.55 },
  { isoCode: 'CO', riskScore: 0.35, visaComplexityScore: 0.25 },
  { isoCode: 'EG', riskScore: 0.40, visaComplexityScore: 0.35 },
  { isoCode: 'GR', riskScore: 0.20, visaComplexityScore: 0.10 },
  { isoCode: 'IN', riskScore: 0.35, visaComplexityScore: 0.45 },
  { isoCode: 'ID', riskScore: 0.35, visaComplexityScore: 0.30 },
  { isoCode: 'IL', riskScore: 0.45, visaComplexityScore: 0.40 },
  { isoCode: 'JO', riskScore: 0.30, visaComplexityScore: 0.30 },
  { isoCode: 'KE', riskScore: 0.40, visaComplexityScore: 0.35 },
  { isoCode: 'MX', riskScore: 0.35, visaComplexityScore: 0.20 },
  { isoCode: 'MA', riskScore: 0.30, visaComplexityScore: 0.30 },
  { isoCode: 'NG', riskScore: 0.50, visaComplexityScore: 0.55 },
  { isoCode: 'PK', riskScore: 0.55, visaComplexityScore: 0.55 },
  { isoCode: 'PH', riskScore: 0.35, visaComplexityScore: 0.25 },
  { isoCode: 'PL', riskScore: 0.12, visaComplexityScore: 0.10 },
  { isoCode: 'QA', riskScore: 0.20, visaComplexityScore: 0.25 },
  { isoCode: 'RO', riskScore: 0.15, visaComplexityScore: 0.10 },
  { isoCode: 'ZA', riskScore: 0.40, visaComplexityScore: 0.30 },
  { isoCode: 'TH', riskScore: 0.30, visaComplexityScore: 0.25 },
  { isoCode: 'TR', riskScore: 0.40, visaComplexityScore: 0.30 },
  { isoCode: 'UA', riskScore: 0.80, visaComplexityScore: 0.40 },
  { isoCode: 'VN', riskScore: 0.30, visaComplexityScore: 0.35 },
  // High risk
  { isoCode: 'AF', riskScore: 0.95, visaComplexityScore: 0.90 },
  { isoCode: 'BY', riskScore: 0.70, visaComplexityScore: 0.60 },
  { isoCode: 'CD', riskScore: 0.80, visaComplexityScore: 0.75 },
  { isoCode: 'ET', riskScore: 0.50, visaComplexityScore: 0.40 },
  { isoCode: 'IQ', riskScore: 0.85, visaComplexityScore: 0.80 },
  { isoCode: 'IR', riskScore: 0.75, visaComplexityScore: 0.80 },
  { isoCode: 'LY', riskScore: 0.80, visaComplexityScore: 0.75 },
  { isoCode: 'MM', riskScore: 0.70, visaComplexityScore: 0.65 },
  { isoCode: 'RU', riskScore: 0.65, visaComplexityScore: 0.55 },
  { isoCode: 'SD', riskScore: 0.80, visaComplexityScore: 0.75 },
  { isoCode: 'SO', riskScore: 0.95, visaComplexityScore: 0.90 },
  { isoCode: 'SY', riskScore: 0.95, visaComplexityScore: 0.90 },
  { isoCode: 'VE', riskScore: 0.65, visaComplexityScore: 0.50 },
  { isoCode: 'YE', riskScore: 0.95, visaComplexityScore: 0.90 },
];

// ─── Visa Risk Pairs ──────────────────────────────────────────────────────────
// "ORIGIN_COUNTRY->DESTINATION_COUNTRY" pairs with known visa friction
// (passport country → destination country; not flight origin/destination)

export const VISA_RISK_PAIRS: Set<string> = new Set([
  'US->RU', 'RU->US',
  'US->CN', 'CN->US',
  'US->IR', 'IR->US',
  'US->CU', 'CU->US',
  'IL->LB', 'LB->IL',
  'IL->IR', 'IR->IL',
  'IL->SY', 'SY->IL',
  'IN->PK', 'PK->IN',
  'SA->IR', 'IR->SA',
  'RU->UA', 'UA->RU',
  'AU->CN', 'CN->AU',
  'GB->BY', 'BY->GB',
  'US->VE', 'VE->US',
  'US->SD', 'SD->US',
  'US->SY', 'SY->US',
  'US->YE', 'YE->US',
]);

// ─── City Airports ────────────────────────────────────────────────────────────
// Maps a canonical city IATA to all airports serving that metro area.
// Used to detect AIRPORT_TRANSFER_REQUIRED warnings.

export const CITY_AIRPORTS: Record<string, string[]> = {
  LON: ['LHR', 'LGW', 'STN', 'LCY', 'LTN', 'SEN'],
  NYC: ['JFK', 'EWR', 'LGA'],
  TYO: ['NRT', 'HND'],
  PAR: ['CDG', 'ORY'],
  MIL: ['MXP', 'LIN', 'BGY'],
  CHI: ['ORD', 'MDW'],
  LAX: ['LAX', 'BUR', 'LGB', 'ONT', 'SNA'],
  ROM: ['FCO', 'CIA'],
  SFO: ['SFO', 'OAK', 'SJC'],
  WAS: ['IAD', 'DCA', 'BWI'],
  HOU: ['IAH', 'HOU'],
  DFW: ['DFW', 'DAL'],
  MIA: ['MIA', 'FLL', 'PBI'],
  OSA: ['KIX', 'ITM'],
  IST: ['IST', 'SAW'],
  BKK: ['BKK', 'DMK'],
  KUL: ['KUL', 'SZB'],
  STO: ['ARN', 'BMA', 'NYO', 'VST'],
  CPH: ['CPH', 'MMX'],
  OSL: ['OSL', 'TRF', 'RYG'],
  MOW: ['SVO', 'DME', 'VKO'],
  WAW: ['WAW', 'WMI'],
};

// ─── Airport Metadata ─────────────────────────────────────────────────────────
// Curated subset of OurAirports dataset covering hubs + common routes.
// country: ISO 3166-1 alpha-2 code

export const AIRPORT_METADATA: Record<string, { country: string; lat: number; lng: number }> = {
  // UK
  LHR: { country: 'GB', lat: 51.4775,  lng: -0.4614  },
  LGW: { country: 'GB', lat: 51.1481,  lng: -0.1903  },
  STN: { country: 'GB', lat: 51.885,   lng: 0.235    },
  LCY: { country: 'GB', lat: 51.5053,  lng: 0.0553   },
  LTN: { country: 'GB', lat: 51.8747,  lng: -0.3683  },
  MAN: { country: 'GB', lat: 53.3537,  lng: -2.2750  },
  EDI: { country: 'GB', lat: 55.9500,  lng: -3.3725  },
  BHX: { country: 'GB', lat: 52.4539,  lng: -1.7480  },
  // France
  CDG: { country: 'FR', lat: 49.0097,  lng: 2.5479   },
  ORY: { country: 'FR', lat: 48.7233,  lng: 2.3794   },
  NCE: { country: 'FR', lat: 43.6584,  lng: 7.2159   },
  LYS: { country: 'FR', lat: 45.7256,  lng: 5.0811   },
  // Netherlands
  AMS: { country: 'NL', lat: 52.3086,  lng: 4.7639   },
  // Germany
  FRA: { country: 'DE', lat: 50.0379,  lng: 8.5622   },
  MUC: { country: 'DE', lat: 48.3537,  lng: 11.7750  },
  BER: { country: 'DE', lat: 52.3667,  lng: 13.5033  },
  DUS: { country: 'DE', lat: 51.2895,  lng: 6.7668   },
  HAM: { country: 'DE', lat: 53.6304,  lng: 9.9882   },
  // Spain
  MAD: { country: 'ES', lat: 40.4936,  lng: -3.5668  },
  BCN: { country: 'ES', lat: 41.2971,  lng: 2.0785   },
  AGP: { country: 'ES', lat: 36.6749,  lng: -4.4991  },
  // Italy
  FCO: { country: 'IT', lat: 41.7999,  lng: 12.2462  },
  CIA: { country: 'IT', lat: 41.7994,  lng: 12.5949  },
  MXP: { country: 'IT', lat: 45.6306,  lng: 8.7281   },
  LIN: { country: 'IT', lat: 45.4508,  lng: 9.2764   },
  BGY: { country: 'IT', lat: 45.6739,  lng: 9.7040   },
  VCE: { country: 'IT', lat: 45.5053,  lng: 12.3519  },
  // Switzerland
  ZRH: { country: 'CH', lat: 47.4647,  lng: 8.5492   },
  GVA: { country: 'CH', lat: 46.2381,  lng: 6.1089   },
  // Austria
  VIE: { country: 'AT', lat: 48.1102,  lng: 16.5697  },
  // Portugal
  LIS: { country: 'PT', lat: 38.7813,  lng: -9.1359  },
  OPO: { country: 'PT', lat: 41.2481,  lng: -8.6814  },
  // Denmark
  CPH: { country: 'DK', lat: 55.6180,  lng: 12.6560  },
  MMX: { country: 'DK', lat: 55.5303,  lng: 13.3762  },
  // Sweden
  ARN: { country: 'SE', lat: 59.6519,  lng: 17.9186  },
  BMA: { country: 'SE', lat: 59.3547,  lng: 17.9397  },
  // Norway
  OSL: { country: 'NO', lat: 60.1939,  lng: 11.1004  },
  // Finland
  HEL: { country: 'FI', lat: 60.3172,  lng: 24.9633  },
  // Poland
  WAW: { country: 'PL', lat: 52.1672,  lng: 20.9679  },
  WMI: { country: 'PL', lat: 52.4511,  lng: 20.6517  },
  KRK: { country: 'PL', lat: 50.0777,  lng: 19.7847  },
  // Greece
  ATH: { country: 'GR', lat: 37.9364,  lng: 23.9445  },
  // Ireland
  DUB: { country: 'IE', lat: 53.4213,  lng: -6.2700  },
  // Turkey
  IST: { country: 'TR', lat: 41.2608,  lng: 28.7418  },
  SAW: { country: 'TR', lat: 40.8986,  lng: 29.3092  },
  AYT: { country: 'TR', lat: 36.8987,  lng: 30.7994  },
  // Russia
  SVO: { country: 'RU', lat: 55.9726,  lng: 37.4146  },
  DME: { country: 'RU', lat: 55.4088,  lng: 37.9063  },
  VKO: { country: 'RU', lat: 55.5915,  lng: 37.2615  },
  LED: { country: 'RU', lat: 59.8003,  lng: 30.2625  },
  // UAE
  DXB: { country: 'AE', lat: 25.2532,  lng: 55.3657  },
  AUH: { country: 'AE', lat: 24.4330,  lng: 54.6511  },
  // Qatar
  DOH: { country: 'QA', lat: 25.2609,  lng: 51.6138  },
  // US
  JFK: { country: 'US', lat: 40.6413,  lng: -73.7781 },
  EWR: { country: 'US', lat: 40.6895,  lng: -74.1745 },
  LGA: { country: 'US', lat: 40.7773,  lng: -73.8726 },
  ORD: { country: 'US', lat: 41.9742,  lng: -87.9073 },
  MDW: { country: 'US', lat: 41.7868,  lng: -87.7522 },
  ATL: { country: 'US', lat: 33.6407,  lng: -84.4277 },
  LAX: { country: 'US', lat: 33.9425,  lng: -118.408 },
  SFO: { country: 'US', lat: 37.6213,  lng: -122.379 },
  OAK: { country: 'US', lat: 37.7213,  lng: -122.221 },
  SJC: { country: 'US', lat: 37.3626,  lng: -121.929 },
  IAD: { country: 'US', lat: 38.9531,  lng: -77.4565 },
  DCA: { country: 'US', lat: 38.8512,  lng: -77.0402 },
  BWI: { country: 'US', lat: 39.1754,  lng: -76.6683 },
  MIA: { country: 'US', lat: 25.7959,  lng: -80.2870 },
  FLL: { country: 'US', lat: 26.0726,  lng: -80.1527 },
  IAH: { country: 'US', lat: 29.9902,  lng: -95.3368 },
  DFW: { country: 'US', lat: 32.8998,  lng: -97.0403 },
  DAL: { country: 'US', lat: 32.8473,  lng: -96.8517 },
  BOS: { country: 'US', lat: 42.3656,  lng: -71.0096 },
  SEA: { country: 'US', lat: 47.4502,  lng: -122.309 },
  DEN: { country: 'US', lat: 39.8561,  lng: -104.674 },
  LAS: { country: 'US', lat: 36.0840,  lng: -115.153 },
  PHX: { country: 'US', lat: 33.4373,  lng: -112.008 },
  MSP: { country: 'US', lat: 44.8820,  lng: -93.2218 },
  DTW: { country: 'US', lat: 42.2124,  lng: -83.3534 },
  CLT: { country: 'US', lat: 35.2140,  lng: -80.9431 },
  // Canada
  YYZ: { country: 'CA', lat: 43.6772,  lng: -79.6306 },
  YVR: { country: 'CA', lat: 49.1967,  lng: -123.184 },
  YUL: { country: 'CA', lat: 45.4706,  lng: -73.7408 },
  YYC: { country: 'CA', lat: 51.1315,  lng: -114.010 },
  // Mexico
  MEX: { country: 'MX', lat: 19.4363,  lng: -99.0721 },
  CUN: { country: 'MX', lat: 21.0365,  lng: -86.8771 },
  // Brazil
  GRU: { country: 'BR', lat: -23.4356, lng: -46.4731 },
  GIG: { country: 'BR', lat: -22.8100, lng: -43.2506 },
  BSB: { country: 'BR', lat: -15.8711, lng: -47.9186 },
  // Argentina
  EZE: { country: 'AR', lat: -34.8222, lng: -58.5358 },
  // Colombia
  BOG: { country: 'CO', lat: 4.7016,   lng: -74.1469 },
  // Japan
  NRT: { country: 'JP', lat: 35.7647,  lng: 140.3864 },
  HND: { country: 'JP', lat: 35.5494,  lng: 139.7798 },
  KIX: { country: 'JP', lat: 34.4272,  lng: 135.244  },
  ITM: { country: 'JP', lat: 34.7854,  lng: 135.438  },
  // China
  PEK: { country: 'CN', lat: 40.0799,  lng: 116.603  },
  PVG: { country: 'CN', lat: 31.1434,  lng: 121.805  },
  CAN: { country: 'CN', lat: 23.3924,  lng: 113.299  },
  // Hong Kong
  HKG: { country: 'HK', lat: 22.308,   lng: 113.9185 },
  // South Korea
  ICN: { country: 'KR', lat: 37.4602,  lng: 126.441  },
  GMP: { country: 'KR', lat: 37.5586,  lng: 126.794  },
  // Singapore
  SIN: { country: 'SG', lat: 1.3644,   lng: 103.9915 },
  // Malaysia
  KUL: { country: 'MY', lat: 2.7456,   lng: 101.710  },
  SZB: { country: 'MY', lat: 3.1306,   lng: 101.549  },
  // Thailand
  BKK: { country: 'TH', lat: 13.6811,  lng: 100.747  },
  DMK: { country: 'TH', lat: 13.9126,  lng: 100.607  },
  HKT: { country: 'TH', lat: 8.1132,   lng: 98.3169  },
  // India
  DEL: { country: 'IN', lat: 28.5562,  lng: 77.1000  },
  BOM: { country: 'IN', lat: 19.0887,  lng: 72.8679  },
  BLR: { country: 'IN', lat: 13.1979,  lng: 77.7063  },
  MAA: { country: 'IN', lat: 12.9900,  lng: 80.1693  },
  // Indonesia
  CGK: { country: 'ID', lat: -6.1256,  lng: 106.656  },
  DPS: { country: 'ID', lat: -8.7482,  lng: 115.167  },
  // Philippines
  MNL: { country: 'PH', lat: 14.5086,  lng: 121.020  },
  // Vietnam
  HAN: { country: 'VN', lat: 21.2212,  lng: 105.807  },
  SGN: { country: 'VN', lat: 10.8188,  lng: 106.652  },
  // Pakistan
  KHI: { country: 'PK', lat: 24.9065,  lng: 67.1608  },
  LHE: { country: 'PK', lat: 31.5216,  lng: 74.4036  },
  ISB: { country: 'PK', lat: 33.6167,  lng: 73.0997  },
  // Australia
  SYD: { country: 'AU', lat: -33.9399, lng: 151.1753 },
  MEL: { country: 'AU', lat: -37.6733, lng: 144.843  },
  BNE: { country: 'AU', lat: -27.3842, lng: 153.117  },
  PER: { country: 'AU', lat: -31.9403, lng: 115.967  },
  // New Zealand
  AKL: { country: 'NZ', lat: -37.0082, lng: 174.792  },
  // South Africa
  JNB: { country: 'ZA', lat: -26.1367, lng: 28.2411  },
  CPT: { country: 'ZA', lat: -33.9648, lng: 18.6017  },
  // Kenya
  NBO: { country: 'KE', lat: -1.3192,  lng: 36.9275  },
  // Nigeria
  LOS: { country: 'NG', lat: 6.5774,   lng: 3.3214   },
  ABV: { country: 'NG', lat: 9.0068,   lng: 7.2632   },
  // Ethiopia
  ADD: { country: 'ET', lat: 8.9779,   lng: 38.7993  },
  // Egypt
  CAI: { country: 'EG', lat: 30.1219,  lng: 31.4056  },
  HRG: { country: 'EG', lat: 27.1783,  lng: 33.7994  },
  // Morocco
  CMN: { country: 'MA', lat: 33.3675,  lng: -7.5900  },
  // Israel
  TLV: { country: 'IL', lat: 32.0114,  lng: 34.8867  },
  // Jordan
  AMM: { country: 'JO', lat: 31.7226,  lng: 35.9932  },
  // Ukraine
  KBP: { country: 'UA', lat: 50.3450,  lng: 30.8947  },
  // Venezuela
  CCS: { country: 'VE', lat: 10.6012,  lng: -66.9913 },
};

// ─── Safe Mode Config ─────────────────────────────────────────────────────────

export const DEFAULT_SAFE_MODE_CONFIG: SafeModeConfig = {
  enabled: false,
  stabilityWeight: 0.30,
  visaRiskPenalty: 0.20,
  longFlightPenalty: 0.10,
};

// ─── Search Mode Configs ──────────────────────────────────────────────────────
// Both standard modes and urgent_get_me_home share the same search envelope.
// urgent_get_me_home differs via relaxedFeasibility, not deeper graph search.

export const SEARCH_MODE_CONFIGS: Record<SearchMode, SearchModeConfig> = {
  best_overall:       { maxHubs: 2, maxFlightSegments: 4, maxFallbackDepth: 1, relaxedFeasibility: false },
  safest:             { maxHubs: 2, maxFlightSegments: 4, maxFallbackDepth: 1, relaxedFeasibility: false },
  best_value:         { maxHubs: 2, maxFlightSegments: 4, maxFallbackDepth: 1, relaxedFeasibility: false },
  fastest_home:       { maxHubs: 2, maxFlightSegments: 4, maxFallbackDepth: 1, relaxedFeasibility: false },
  urgent_get_me_home: { maxHubs: 2, maxFlightSegments: 4, maxFallbackDepth: 1, relaxedFeasibility: true  },
};

// ─── Feasibility Rule Tables ──────────────────────────────────────────────────
// Empty at MVP. Populated when rule data is sourced.

export const VISA_RULES: VisaRule[] = [];
export const TRANSIT_RULES: TransitRule[] = [];
export const COUNTRY_ACCESS_RULES: CountryAccessRule[] = [];
