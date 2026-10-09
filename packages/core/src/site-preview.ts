/**
 * A preview of the website the agency would build a business that has none
 * (2026-10-08): the page behind a preview link, made from its Google listing
 * — its name, category, city, rating, address and phone — and a template for
 * its kind of business.
 *
 * Pure: the words and colours for a Google category. The template says only
 * what any business of the kind offers, phrased as an example ("Check-ups
 * and cleaning"), never a claim about THIS business — it is a preview the
 * owner reads, banner and all, and the real site is built with their own
 * services and prices.
 */

export interface SiteTemplate {
  /** The kind of business, as a heading: "Dental clinic". */
  readonly kind: string
  /** One line under the name. `{city}` is replaced, or dropped with its comma when there is none. */
  readonly tagline: string
  /** Example services a business of this kind offers. */
  readonly services: readonly string[]
  /** What a customer most wants to do: the main button's words. */
  readonly action: string
  /** Two colours for the hero: a deep one and a light one. */
  readonly colours: readonly [deep: string, light: string]
}

const T = (
  kind: string,
  tagline: string,
  services: readonly string[],
  action: string,
  colours: readonly [string, string],
): SiteTemplate => ({ kind, tagline, services, action, colours })

const TEMPLATES: Readonly<Record<string, SiteTemplate>> = {
  dentist: T('Dental clinic', 'Gentle, modern dental care{, in city}', ['Check-ups and cleaning', 'Fillings and root canal', 'Braces and clear aligners', 'Teeth whitening', 'Dental implants', 'Children’s dentistry'], 'Book an appointment', ['#0e4d64', '#e6f4f1']),
  doctor: T('Clinic', 'Care you can trust{, in city}', ['General consultation', 'Health check-ups', 'Vaccinations', 'Lab tests', 'Follow-up care', 'Teleconsultation'], 'Book a consultation', ['#1d4e89', '#e8f0fb']),
  physiotherapist: T('Physiotherapy clinic', 'Move better, feel better{, in city}', ['Back and neck pain', 'Sports injuries', 'Post-surgery rehab', 'Joint pain', 'Posture correction', 'Home visits'], 'Book a session', ['#22577a', '#e5f2f7']),
  hospital: T('Hospital', 'Complete care under one roof{, in city}', ['Emergency care', 'Specialist consultations', 'Diagnostics', 'Surgery', 'Maternity', 'Pharmacy'], 'Call us', ['#1b3a4b', '#e7eef2']),
  pharmacy: T('Pharmacy', 'Your neighbourhood pharmacy{, in city}', ['Prescription medicines', 'Over-the-counter care', 'Health and wellness', 'Baby care', 'Home delivery', 'Medical devices'], 'Order on WhatsApp', ['#2d6a4f', '#e9f5ee']),
  veterinary_care: T('Veterinary clinic', 'Caring for your pets{, in city}', ['Check-ups', 'Vaccinations', 'Surgery', 'Grooming', 'Dental care for pets', 'Emergency visits'], 'Book a visit', ['#5c3d2e', '#f6efe9']),
  beauty_salon: T('Beauty salon', 'Look and feel your best{, in city}', ['Haircuts and styling', 'Hair colour', 'Facials and skin care', 'Manicure and pedicure', 'Bridal makeup', 'Waxing and threading'], 'Book an appointment', ['#7b2d5b', '#fbeef5']),
  hair_care: T('Hair salon', 'Great hair, every day{, in city}', ['Haircuts', 'Colour and highlights', 'Keratin and smoothening', 'Hair spa', 'Beard grooming', 'Bridal styling'], 'Book an appointment', ['#6a2c70', '#f7edf8']),
  spa: T('Spa', 'Relax, restore, renew{, in city}', ['Full-body massage', 'Aromatherapy', 'Facials', 'Body scrubs', 'Couples packages', 'Gift vouchers'], 'Book a treatment', ['#3d5a50', '#edf4f1']),
  gym: T('Fitness studio', 'Get stronger, every week{, in city}', ['Strength training', 'Cardio', 'Personal training', 'Group classes', 'Diet guidance', 'Monthly memberships'], 'Book a free trial', ['#1f1f1f', '#f2f2f2']),
  restaurant: T('Restaurant', 'Good food, warm welcome{, in city}', ['Dine-in', 'Takeaway', 'Home delivery', 'Party orders', 'Catering', 'Chef’s specials'], 'Order or reserve', ['#8a2c0d', '#fbefe9']),
  cafe: T('Café', 'Coffee, food and good company{, in city}', ['Coffee and tea', 'Breakfast', 'Sandwiches and snacks', 'Desserts', 'Takeaway', 'Work-friendly seating'], 'See the menu', ['#5b3a29', '#f7efe8']),
  bakery: T('Bakery', 'Fresh from the oven every day{, in city}', ['Breads', 'Cakes to order', 'Cookies and pastries', 'Birthday cakes', 'Party orders', 'Eggless options'], 'Order a cake', ['#9c5518', '#fcf2e6']),
  meal_takeaway: T('Kitchen', 'Hot food, to your door{, in city}', ['Meals', 'Combos', 'Family packs', 'Party orders', 'Home delivery', 'Daily specials'], 'Order now', ['#9b2226', '#fbecec']),
  lodging: T('Hotel', 'A comfortable stay{, in city}', ['Rooms and suites', 'Free Wi-Fi', 'Restaurant', 'Airport pickup', 'Events and banquets', 'Long-stay rates'], 'Check availability', ['#264653', '#e9f1f3']),
  real_estate_agency: T('Real estate', 'Find the right home{, in city}', ['Flats for sale', 'Homes for rent', 'Commercial spaces', 'Plots', 'Home loans help', 'Site visits'], 'Book a site visit', ['#283618', '#eef2e6']),
  lawyer: T('Law practice', 'Clear advice when it matters{, in city}', ['Property matters', 'Family law', 'Civil cases', 'Company and contracts', 'Consumer disputes', 'Legal notices'], 'Book a consultation', ['#1d2d44', '#e9edf3']),
  accounting: T('Accounting firm', 'Taxes and books, done right{, in city}', ['GST filing', 'Income tax returns', 'Bookkeeping', 'Company registration', 'Audits', 'Payroll'], 'Talk to us', ['#14213d', '#e8ebf2']),
  car_repair: T('Car service', 'Reliable car care{, in city}', ['General service', 'Repairs', 'Denting and painting', 'AC service', 'Tyres and batteries', 'Pick-up and drop'], 'Book a service', ['#22333b', '#ebeff1']),
  clothing_store: T('Fashion store', 'New styles, every season{, in city}', ['Men', 'Women', 'Kids', 'Ethnic wear', 'Accessories', 'Alterations'], 'Shop on WhatsApp', ['#3c1642', '#f4ecf5']),
  jewelry_store: T('Jewellers', 'Crafted to be treasured{, in city}', ['Gold jewellery', 'Diamond jewellery', 'Silver', 'Bridal collections', 'Custom designs', 'Old gold exchange'], 'Visit the store', ['#5f4b0f', '#faf5e4']),
  furniture_store: T('Furniture store', 'Furniture for every room{, in city}', ['Living room', 'Bedroom', 'Dining', 'Office', 'Custom furniture', 'Home delivery'], 'See the collection', ['#4a3728', '#f5efe9']),
  electronics_store: T('Electronics store', 'The latest gadgets, best prices{, in city}', ['Mobiles', 'Laptops', 'TVs and audio', 'Home appliances', 'Accessories', 'Easy EMI'], 'Ask for a price', ['#0b3954', '#e7f0f6']),
  school: T('School', 'Learning that lasts{, in city}', ['Admissions', 'Curriculum', 'Activities and sports', 'Transport', 'Facilities', 'Parent connect'], 'Enquire about admission', ['#1b4332', '#e8f3ec']),
  plumber: T('Plumbing services', 'Fast, tidy plumbing{, in city}', ['Leak repairs', 'Bathroom fittings', 'Water tanks', 'Drain cleaning', 'Pipe work', 'Emergency visits'], 'Call a plumber', ['#023e8a', '#e7eefa']),
  electrician: T('Electrical services', 'Safe, reliable electrical work{, in city}', ['Wiring', 'Repairs', 'Fan and light fitting', 'Inverters', 'Safety checks', 'Emergency visits'], 'Call an electrician', ['#a35d00', '#fdf3e4']),
  travel_agency: T('Travel agency', 'Trips planned for you{, in city}', ['Holiday packages', 'Flights', 'Hotels', 'Visas', 'Group tours', 'Pilgrimages'], 'Plan a trip', ['#006d77', '#e6f4f5']),
  florist: T('Florist', 'Flowers for every occasion{, in city}', ['Bouquets', 'Wedding decor', 'Birthday flowers', 'Event decoration', 'Same-day delivery', 'Plants'], 'Order flowers', ['#9d0208', '#fdecec']),
}

const FALLBACK = T('Business', 'Serving customers{, in city}', ['Our services', 'Quality you can trust', 'Friendly team', 'Fair prices', 'Easy to reach', 'Happy customers'], 'Get in touch', ['#1f2937', '#eef1f4'])

/** Some Google categories that mean one of the templates above. */
const ALIASES: Readonly<Record<string, string>> = {
  dental_clinic: 'dentist', medical_clinic: 'doctor', hair_salon: 'hair_care', barber_shop: 'hair_care', nail_salon: 'beauty_salon',
  fitness_center: 'gym', yoga_studio: 'gym', bar: 'restaurant', fast_food_restaurant: 'meal_takeaway', meal_delivery: 'meal_takeaway',
  hotel: 'lodging', guest_house: 'lodging', resort_hotel: 'lodging', real_estate: 'real_estate_agency', law_firm: 'lawyer',
  accountant: 'accounting', car_dealer: 'car_repair', auto_parts_store: 'car_repair', shoe_store: 'clothing_store',
  home_goods_store: 'furniture_store', primary_school: 'school', secondary_school: 'school', preschool: 'school',
  veterinarian: 'veterinary_care', drugstore: 'pharmacy', chemist: 'pharmacy',
}

export function siteTemplateFor(category: string | null | undefined): SiteTemplate {
  if (!category) return FALLBACK
  const key = Object.prototype.hasOwnProperty.call(TEMPLATES, category) ? category : ALIASES[category]
  return (key && Object.prototype.hasOwnProperty.call(TEMPLATES, key) ? TEMPLATES[key] : undefined) ?? FALLBACK
}

/** The tagline with the city put in, or the city clause dropped when there is none. */
export function siteTagline(template: SiteTemplate, city: string | null | undefined): string {
  const c = city?.trim()
  return template.tagline.replace('{, in city}', c ? `, in ${c}` : '')
}

/**
 * A phone on record (E.164) as a person reads it: an Indian number as
 * `+91 98765 43210`, any other as stored. Display only — a link still dials
 * the E.164 form.
 */
export function phoneForDisplay(phone: string): string {
  const india = /^\+91([0-9]{10})$/.exec(phone)
  return india ? `+91 ${india[1]!.slice(0, 5)} ${india[1]!.slice(5)}` : phone
}

/** A wa.me link for a phone on record (E.164), or null. */
export function whatsappLink(phone: string | null | undefined, text?: string): string | null {
  if (!phone || !/^\+[1-9][0-9]{6,14}$/.test(phone)) return null
  return `https://wa.me/${phone.slice(1)}${text ? `?text=${encodeURIComponent(text)}` : ''}`
}
