/**
 * The version of the terms of service and the privacy notice that the portal shows (README §2, Public). Sign-up
 * sends it as `termsVersion`, and the API keeps it with the time of acceptance (PF-01); `/legal/terms` and
 * `/legal/privacy` show it, so the pages and the stored acceptance name the same text. Change it whenever the text
 * of either page changes in substance. At most 32 characters (`SignUpRequest.termsVersion` of the platform
 * document).
 */
export const termsVersion = "2026-10-01";
