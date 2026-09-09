export const today = "2026-09-08";
export const active = body => ({ headers: { response_code: "0000" }, body });
export const candidate = (overrides = {}) => ({ id: 123, name: "E-TCF CANADA - 4 modules", number: "TCFC-NY",
  location: { label: "North York" }, fee: { label: "$390" }, num_of_sub_activities: 0, parent_activity: false, ...overrides });
export const search = (items = [], page = 1, total = items.length, size = 20) => ({
  headers: { response_code: "0000", page_info: { page_number: page, total_records: total, total_records_per_page: size,
    total_page: Math.max(1, Math.ceil(total / size)) } }, body: { activity_items: items },
});
export const detail = (overrides = {}) => active({ detail: { activity_id: 123, activity_name: "E-TCF CANADA - 4 modules",
  is_parent_activity: false, first_date: "2026-10-05", last_date: "2026-10-05", location_description: "47 Sheppard Avenue E. 5th floor",
  space_status: "2 openings remaining", ...overrides } });
export const button = (overrides = {}, action = {}) => active({ button_status: { notification: "", time_remaining: 0,
  action_link: { href: "https://anc.ca.apm.activecommunities.com/aftoronto/activity/search/enroll/123?locale=en-US", label: "Enroll Now", ...action }, ...overrides } });
export const examination = (overrides = {}) => ({ IDEXAMINATION: 2771, IDEXAMINATION_TYPE: 10, product_name: "TCF CANADA",
  examination_date: "2026-10-05", formattedEnrollmentDate: "20/08/2026", examination_enroll_end_date_formatted: "27/09/2026",
  qty_student: 15, max_student: 31, isFull: false, inscriptionIsInFuture: false, inscriptions_started: null, inscriptions_are_over: null,
  examination_location: "317 Place d'Youville, H2Y 2B5", examination_start_time_formatted: "00:00", price_formatted: "390,00 $",
  mainRegisterLink: { link: "https://www.afmontreal.ca/panier/#/addExamination/2771", label: "add_to_cart", cantRegisterReason: "" }, ...overrides });
export const montreal = (exams = [examination()]) => [{ IDEXAMINATION_TYPE: 10, name: "TCF CANADA", examinations: exams }];
export const response = data => ({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
export function providerRoute(url) {
  if (url.includes("/rest/activities/list")) return response(search());
  if (url.includes("examination_type_detail")) return { status: 200, contentType: "text/html", body: 'var aec_app_url="https://afmontreal.aec.app"; var aecExtranetWebAppsAPIKey="fixture-public-key";' };
  if (url.includes("/public/examinations/list")) return response(montreal());
  throw new Error(`Unexpected fixture request ${url}`);
}
