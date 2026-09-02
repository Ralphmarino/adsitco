/**
 * Country codes across the two APIs.
 *
 * Analytics and Search Console disagree on how to name a country: GA4 reports
 * `country` as an English display name and `countryId` as ISO 3166-1 alpha-2
 * ("US"), while Search Console uses alpha-3 ("usa") for both its dimension
 * values and its filters. One filter has to speak all three, so alpha-3 is the
 * canonical form here — it is what Search Console needs, and the map carries
 * the alpha-2 and display name for the other two.
 *
 * The list covers the markets a site realistically sees rather than all ~250
 * ISO entries. Anything missing simply does not appear in the filter, which is
 * the honest failure: an unmappable country would silently filter one source
 * and not the other.
 */

// alpha-3, alpha-2, display name
const TABLE = [
  ["usa", "US", "United States"],
  ["can", "CA", "Canada"],
  ["gbr", "GB", "United Kingdom"],
  ["aus", "AU", "Australia"],
  ["nzl", "NZ", "New Zealand"],
  ["irl", "IE", "Ireland"],
  ["deu", "DE", "Germany"],
  ["fra", "FR", "France"],
  ["esp", "ES", "Spain"],
  ["ita", "IT", "Italy"],
  ["nld", "NL", "Netherlands"],
  ["bel", "BE", "Belgium"],
  ["che", "CH", "Switzerland"],
  ["aut", "AT", "Austria"],
  ["swe", "SE", "Sweden"],
  ["nor", "NO", "Norway"],
  ["dnk", "DK", "Denmark"],
  ["fin", "FI", "Finland"],
  ["isl", "IS", "Iceland"],
  ["prt", "PT", "Portugal"],
  ["pol", "PL", "Poland"],
  ["cze", "CZ", "Czechia"],
  ["svk", "SK", "Slovakia"],
  ["hun", "HU", "Hungary"],
  ["rou", "RO", "Romania"],
  ["bgr", "BG", "Bulgaria"],
  ["grc", "GR", "Greece"],
  ["hrv", "HR", "Croatia"],
  ["svn", "SI", "Slovenia"],
  ["srb", "RS", "Serbia"],
  ["ukr", "UA", "Ukraine"],
  ["est", "EE", "Estonia"],
  ["lva", "LV", "Latvia"],
  ["ltu", "LT", "Lithuania"],
  ["lux", "LU", "Luxembourg"],
  ["mlt", "MT", "Malta"],
  ["cyp", "CY", "Cyprus"],
  ["tur", "TR", "Türkiye"],
  ["rus", "RU", "Russia"],
  ["mex", "MX", "Mexico"],
  ["bra", "BR", "Brazil"],
  ["arg", "AR", "Argentina"],
  ["chl", "CL", "Chile"],
  ["col", "CO", "Colombia"],
  ["per", "PE", "Peru"],
  ["ecu", "EC", "Ecuador"],
  ["ury", "UY", "Uruguay"],
  ["pan", "PA", "Panama"],
  ["cri", "CR", "Costa Rica"],
  ["dom", "DO", "Dominican Republic"],
  ["pri", "PR", "Puerto Rico"],
  ["jam", "JM", "Jamaica"],
  ["tto", "TT", "Trinidad and Tobago"],
  ["bhs", "BS", "Bahamas"],
  ["are", "AE", "United Arab Emirates"],
  ["sau", "SA", "Saudi Arabia"],
  ["qat", "QA", "Qatar"],
  ["kwt", "KW", "Kuwait"],
  ["bhr", "BH", "Bahrain"],
  ["omn", "OM", "Oman"],
  ["isr", "IL", "Israel"],
  ["jor", "JO", "Jordan"],
  ["lbn", "LB", "Lebanon"],
  ["egy", "EG", "Egypt"],
  ["mar", "MA", "Morocco"],
  ["dza", "DZ", "Algeria"],
  ["tun", "TN", "Tunisia"],
  ["zaf", "ZA", "South Africa"],
  ["nga", "NG", "Nigeria"],
  ["ken", "KE", "Kenya"],
  ["gha", "GH", "Ghana"],
  ["ind", "IN", "India"],
  ["pak", "PK", "Pakistan"],
  ["bgd", "BD", "Bangladesh"],
  ["lka", "LK", "Sri Lanka"],
  ["npl", "NP", "Nepal"],
  ["chn", "CN", "China"],
  ["hkg", "HK", "Hong Kong"],
  ["twn", "TW", "Taiwan"],
  ["jpn", "JP", "Japan"],
  ["kor", "KR", "South Korea"],
  ["sgp", "SG", "Singapore"],
  ["mys", "MY", "Malaysia"],
  ["tha", "TH", "Thailand"],
  ["idn", "ID", "Indonesia"],
  ["phl", "PH", "Philippines"],
  ["vnm", "VN", "Vietnam"],
  ["khm", "KH", "Cambodia"],
];

const BY_ALPHA3 = new Map(TABLE.map(([a3, a2, name]) => [a3, { alpha3: a3, alpha2: a2, name }]));
const BY_NAME = new Map(TABLE.map(([a3, a2, name]) => [name.toLowerCase(), { alpha3: a3, alpha2: a2, name }]));

export const DEFAULT_COUNTRY = "usa";

export function lookupCountry(value) {
  if (!value) return null;
  const key = String(value).trim().toLowerCase();
  return BY_ALPHA3.get(key) ?? BY_NAME.get(key) ?? null;
}

/** Display name for a Search Console alpha-3 code, or the code if unmapped. */
export function countryName(alpha3) {
  return BY_ALPHA3.get(String(alpha3).toLowerCase())?.name ?? alpha3;
}

/** Every selectable country, alphabetical, for the filter control. */
export function countryOptions() {
  return TABLE.map(([alpha3, , name]) => ({ value: alpha3, name })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}
