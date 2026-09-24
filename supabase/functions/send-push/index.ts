// supabase/functions/send-push/index.ts
//
// Sends the waiting notifications to parents' phones through Expo's push service, each in the parent's own language.
// Self-contained: paste this whole file into the dashboard editor as a new function called "send-push".
//
// Before it can work (once):
//   1. Run supabase/migrations/20260920000400_notifications.sql in the SQL editor.
//   2. Set the secret SB_SECRET_KEY to a Supabase secret key (sb_secret_...). Reading the queue needs it.
//   3. Build the app with Expo (the APK), so phones have a push token. Android also needs a Firebase project
//      connected to the Expo build; see the README in the app repository.
//   4. Optional but recommended: in expo.dev, switch on "Enhanced Security for Push Notifications", make an access
//      token, and set it here as the secret EXPO_ACCESS_TOKEN.
//   5. Run supabase/migrations/20260925000100_send_push_schedule.sql, which asks Postgres to call this once a minute.
//      Without that nothing calls it, the queue fills up, and the phones stay quiet however well everything else is set.
//
// Who may call it: the scheduled job, presenting the secret key itself - that is how it is normally called - or a
// Kidscover admin or a school's own staff, signed in.
//
// What a phone shows: "<school name>" and one short line - that the school replied, or which stage an application
// reached. Never the words of a message: a locked screen is not a private place.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ==== BEGIN testable logic (must not use imports or Deno globals) ====

const EXPO_URL = "https://exp.host/--/api/v2/push/send";
const CHUNK = 100;
const SEND_TIMEOUT_MS = 15000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// ==== BEGIN push words (generated from the app's own translations by scripts/build-push-words.cjs) ====
const PUSH_WORDS: Record<string, Record<string, string>> = {
  en: {
    "push.reply.body": "The school replied to your enquiry.",
    "push.status.body": "Your application is now: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "Being looked at",
    "stage.visit_scheduled": "Visit arranged",
    "stage.offered": "A place is offered",
    "stage.waitlisted": "On the waiting list",
    "stage.accepted": "Accepted",
    "stage.declined": "Not offered a place",
  },
  ar: {
    "push.reply.body": "ردّت المدرسة على استفسارك.",
    "push.status.body": "حالة طلبك الآن: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "قيد المراجعة",
    "stage.visit_scheduled": "حُدّد موعد زيارة",
    "stage.offered": "عُرض مقعد",
    "stage.waitlisted": "في قائمة الانتظار",
    "stage.accepted": "تم القبول",
    "stage.declined": "لم يُمنح مقعد",
  },
  as: {
    "push.reply.body": "বিদ্যালয়ে আপোনাৰ সোধা-পোছাৰ উত্তৰ দিছে।",
    "push.status.body": "আপোনাৰ আবেদন এতিয়া: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "চোৱা হৈ আছে",
    "stage.visit_scheduled": "চাবলৈ যোৱাৰ দিন ঠিক হ'ল",
    "stage.offered": "আসন দিয়া হ'ল",
    "stage.waitlisted": "অপেক্ষা তালিকাত",
    "stage.accepted": "গ্ৰহণ কৰা হ'ল",
    "stage.declined": "আসন পোৱা নগ'ল",
  },
  bn: {
    "push.reply.body": "স্কুল আপনার প্রশ্নের উত্তর দিয়েছে।",
    "push.status.body": "আপনার আবেদন এখন: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "দেখা হচ্ছে",
    "stage.visit_scheduled": "দেখা করার দিন ঠিক",
    "stage.offered": "আসন দেওয়া হয়েছে",
    "stage.waitlisted": "অপেক্ষমাণ তালিকায়",
    "stage.accepted": "গৃহীত",
    "stage.declined": "আসন মেলেনি",
  },
  brx: {
    "push.reply.body": "फरायसालिया नोंथांनि सोंनायखौ फिनबाय।",
    "push.status.body": "नोंथांनि आबेदना दा: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "नायगासिनो दं",
    "stage.visit_scheduled": "नायनो फैनाय सान थिबाय",
    "stage.offered": "जायगा होबाय",
    "stage.waitlisted": "नेथ'नाय लिस्टाव",
    "stage.accepted": "गनायबाय",
    "stage.declined": "जायगा मोनाखै",
  },
  de: {
    "push.reply.body": "Die Schule hat auf Ihre Anfrage geantwortet.",
    "push.status.body": "Ihre Bewerbung ist jetzt: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "Wird geprüft",
    "stage.visit_scheduled": "Besichtigung vereinbart",
    "stage.offered": "Platz angeboten",
    "stage.waitlisted": "Auf der Warteliste",
    "stage.accepted": "Angenommen",
    "stage.declined": "Kein Platz",
  },
  doi: {
    "push.reply.body": "स्कूल ने तुंदी पुच्छ-गिच्छ दा जवाब दित्ता ऐ।",
    "push.status.body": "तुंदी अर्जी हुन: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "दिक्खी जा दी ऐ",
    "stage.visit_scheduled": "मिलने दा दिन तय होया",
    "stage.offered": "सीट दित्ती गेई",
    "stage.waitlisted": "उडीक सूची च",
    "stage.accepted": "मन्नी लेई",
    "stage.declined": "सीट नेईं मिल्ली",
  },
  es: {
    "push.reply.body": "El colegio ha respondido a tu consulta.",
    "push.status.body": "Tu solicitud está ahora: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "En revisión",
    "stage.visit_scheduled": "Visita concertada",
    "stage.offered": "Plaza ofrecida",
    "stage.waitlisted": "En lista de espera",
    "stage.accepted": "Aceptada",
    "stage.declined": "Sin plaza",
  },
  fr: {
    "push.reply.body": "L'école a répondu à votre demande.",
    "push.status.body": "Votre candidature est maintenant : {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "En cours d'examen",
    "stage.visit_scheduled": "Visite programmée",
    "stage.offered": "Place proposée",
    "stage.waitlisted": "Sur liste d'attente",
    "stage.accepted": "Acceptée",
    "stage.declined": "Pas de place",
  },
  gu: {
    "push.reply.body": "શાળાએ તમારી પૂછપરછનો જવાબ આપ્યો છે.",
    "push.status.body": "તમારી અરજી હવે: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "જોવાઈ રહી છે",
    "stage.visit_scheduled": "મુલાકાત નક્કી",
    "stage.offered": "જગ્યા આપી",
    "stage.waitlisted": "પ્રતીક્ષા યાદીમાં",
    "stage.accepted": "સ્વીકારી",
    "stage.declined": "જગ્યા મળી નથી",
  },
  hi: {
    "push.reply.body": "स्कूल ने आपकी पूछताछ का जवाब दिया है।",
    "push.status.body": "आपका आवेदन अब: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "देखा जा रहा है",
    "stage.visit_scheduled": "मुलाक़ात तय हुई",
    "stage.offered": "सीट का प्रस्ताव",
    "stage.waitlisted": "प्रतीक्षा सूची में",
    "stage.accepted": "स्वीकार",
    "stage.declined": "सीट नहीं मिली",
  },
  ja: {
    "push.reply.body": "学校から問い合わせへの返信が届きました。",
    "push.status.body": "出願の状況：{stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "審査中",
    "stage.visit_scheduled": "見学日が決定",
    "stage.offered": "入学枠の案内あり",
    "stage.waitlisted": "補欠リスト",
    "stage.accepted": "受理されました",
    "stage.declined": "入学枠なし",
  },
  kn: {
    "push.reply.body": "ಶಾಲೆ ನಿಮ್ಮ ವಿಚಾರಣೆಗೆ ಉತ್ತರಿಸಿದೆ.",
    "push.status.body": "ನಿಮ್ಮ ಅರ್ಜಿ ಈಗ: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "ಪರಿಶೀಲನೆಯಲ್ಲಿದೆ",
    "stage.visit_scheduled": "ಭೇಟಿ ನಿಗದಿಯಾಗಿದೆ",
    "stage.offered": "ಸೀಟು ನೀಡಲಾಗಿದೆ",
    "stage.waitlisted": "ಕಾಯುವ ಪಟ್ಟಿಯಲ್ಲಿ",
    "stage.accepted": "ಸ್ವೀಕರಿಸಲಾಗಿದೆ",
    "stage.declined": "ಸೀಟು ಸಿಗಲಿಲ್ಲ",
  },
  kok: {
    "push.reply.body": "शाळेन तुमच्या विचारणेक जाप दिल्या.",
    "push.status.body": "तुमचो अर्ज आतां: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "पळयतात",
    "stage.visit_scheduled": "भेट थारायल्या",
    "stage.offered": "जागो दिला",
    "stage.waitlisted": "वाट पळोवपी वळेरेंत",
    "stage.accepted": "मान्य केला",
    "stage.declined": "जागो मेळ्ळो ना",
  },
  ks: {
    "push.reply.body": "سکولن دِیُت توٚہٕنٛدِ پرژھنہٕ ہُنٛد جواب۔",
    "push.status.body": "توٚہٕنٛز درخواست وُنہٕ: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "وُچھنہٕ یِوان چھےٚ",
    "stage.visit_scheduled": "وُچھنہٕ یِنُک دۄہ مُقرر",
    "stage.offered": "سیٹ دِنہٕ آو",
    "stage.waitlisted": "انتظار فہرستس منز",
    "stage.accepted": "قبول کرنہٕ آیہٕ",
    "stage.declined": "سیٹ آو نہٕ لبنہٕ",
  },
  mai: {
    "push.reply.body": "विद्यालय अहाँक पूछताछक उत्तर देलक अछि।",
    "push.status.body": "अहाँक आवेदन आब: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "देखल जा रहल अछि",
    "stage.visit_scheduled": "भेँट तय भेल",
    "stage.offered": "सीट देल गेल",
    "stage.waitlisted": "प्रतीक्षा सूची मे",
    "stage.accepted": "स्वीकार कएल गेल",
    "stage.declined": "सीट नहि भेटल",
  },
  ml: {
    "push.reply.body": "സ്കൂൾ നിങ്ങളുടെ അന്വേഷണത്തിന് മറുപടി നൽകി.",
    "push.status.body": "നിങ്ങളുടെ അപേക്ഷ ഇപ്പോൾ: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "പരിശോധിക്കുന്നു",
    "stage.visit_scheduled": "സന്ദർശനം നിശ്ചയിച്ചു",
    "stage.offered": "സീറ്റ് വാഗ്ദാനം ചെയ്തു",
    "stage.waitlisted": "കാത്തിരിപ്പ് പട്ടികയിൽ",
    "stage.accepted": "സ്വീകരിച്ചു",
    "stage.declined": "സീറ്റ് കിട്ടിയില്ല",
  },
  mni: {
    "push.reply.body": "স্কুলনা নঙগী হংবদা পাউখুম পীরে।",
    "push.status.body": "নঙগী এপ্লিকেসন হৌজিক: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "য়েংলি",
    "stage.visit_scheduled": "য়েংবা লাকপগী তাং লেপখ্রে",
    "stage.offered": "সিত পীখ্রে",
    "stage.waitlisted": "ঙাইজবগী পরিংদা",
    "stage.accepted": "লৌখ্রে",
    "stage.declined": "সিত ফংদে",
  },
  mr: {
    "push.reply.body": "शाळेने तुमच्या विचारणेला उत्तर दिले आहे.",
    "push.status.body": "तुमचा अर्ज आता: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "पाहिला जात आहे",
    "stage.visit_scheduled": "भेट ठरली",
    "stage.offered": "जागा देऊ केली",
    "stage.waitlisted": "प्रतीक्षा यादीत",
    "stage.accepted": "स्वीकारला",
    "stage.declined": "जागा मिळाली नाही",
  },
  ne: {
    "push.reply.body": "विद्यालयले तपाईंको सोधपुछको जवाफ दिएको छ।",
    "push.status.body": "तपाईंको निवेदन अहिले: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "हेरिँदै छ",
    "stage.visit_scheduled": "भेट्ने दिन तय भयो",
    "stage.offered": "सिट दिइयो",
    "stage.waitlisted": "प्रतीक्षा सूचीमा",
    "stage.accepted": "स्वीकार गरियो",
    "stage.declined": "सिट पाइएन",
  },
  or: {
    "push.reply.body": "ବିଦ୍ୟାଳୟ ଆପଣଙ୍କ ପଚରାଉଚରାର ଉତ୍ତର ଦେଇଛି।",
    "push.status.body": "ଆପଣଙ୍କ ଆବେଦନ ଏବେ: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "ଦେଖାଯାଉଛି",
    "stage.visit_scheduled": "ଯିବା ଦିନ ଧାର୍ଯ୍ୟ",
    "stage.offered": "ସିଟ୍ ମିଳିଲା",
    "stage.waitlisted": "ଅପେକ୍ଷା ତାଲିକାରେ",
    "stage.accepted": "ଗ୍ରହଣ କରାଗଲା",
    "stage.declined": "ସିଟ୍ ମିଳିଲା ନାହିଁ",
  },
  pa: {
    "push.reply.body": "ਸਕੂਲ ਨੇ ਤੁਹਾਡੀ ਪੁੱਛ-ਗਿੱਛ ਦਾ ਜਵਾਬ ਦਿੱਤਾ ਹੈ।",
    "push.status.body": "ਤੁਹਾਡੀ ਅਰਜ਼ੀ ਹੁਣ: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "ਵੇਖੀ ਜਾ ਰਹੀ ਹੈ",
    "stage.visit_scheduled": "ਗੇੜਾ ਤੈਅ ਹੋਇਆ",
    "stage.offered": "ਸੀਟ ਮਿਲੀ",
    "stage.waitlisted": "ਉਡੀਕ ਸੂਚੀ ਵਿੱਚ",
    "stage.accepted": "ਮੰਨ ਲਈ",
    "stage.declined": "ਸੀਟ ਨਹੀਂ ਮਿਲੀ",
  },
  pt: {
    "push.reply.body": "A escola respondeu ao seu contato.",
    "push.status.body": "Sua inscrição agora está: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "Em análise",
    "stage.visit_scheduled": "Visita marcada",
    "stage.offered": "Vaga oferecida",
    "stage.waitlisted": "Na lista de espera",
    "stage.accepted": "Aceita",
    "stage.declined": "Sem vaga",
  },
  ru: {
    "push.reply.body": "Школа ответила на ваше обращение.",
    "push.status.body": "Ваше заявление сейчас: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "На рассмотрении",
    "stage.visit_scheduled": "Назначено посещение",
    "stage.offered": "Место предложено",
    "stage.waitlisted": "В списке ожидания",
    "stage.accepted": "Принято",
    "stage.declined": "Места нет",
  },
  sa: {
    "push.reply.body": "विद्यालयः भवतः प्रश्नस्य उत्तरं दत्तवान्।",
    "push.status.body": "भवतः आवेदनम् अधुना: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "परीक्ष्यते",
    "stage.visit_scheduled": "दर्शनदिनं निश्चितम्",
    "stage.offered": "स्थानं दत्तम्",
    "stage.waitlisted": "प्रतीक्षासूच्याम्",
    "stage.accepted": "स्वीकृतम्",
    "stage.declined": "स्थानं न प्राप्तम्",
  },
  sat: {
    "push.reply.body": "ᱟᱹᱨᱤᱪᱟᱹᱞᱤ ᱟᱢᱟᱜ ᱠᱩᱠᱞᱤ ᱨᱮᱭᱟᱜ ᱛᱮᱞᱟ ᱮᱢ ᱟᱠᱟᱫᱟ᱾",
    "push.status.body": "ᱟᱢᱟᱜ ᱟᱨᱡᱤ ᱱᱤᱛᱚᱜ: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "ᱧᱮᱞ ᱠᱟᱱᱟ",
    "stage.visit_scheduled": "ᱧᱮᱞ ᱦᱮᱡ ᱢᱟᱦᱟᱸ ᱴᱷᱤᱠ ᱮᱱᱟ",
    "stage.offered": "ᱡᱟᱭᱜᱟ ᱮᱢ ᱮᱱᱟ",
    "stage.waitlisted": "ᱛᱟᱸᱜᱤ ᱞᱤᱥᱴ ᱨᱮ",
    "stage.accepted": "ᱢᱟᱱᱟᱣ ᱮᱱᱟ",
    "stage.declined": "ᱡᱟᱭᱜᱟ ᱵᱟᱭ ᱧᱟᱢ ᱞᱮᱱᱟ",
  },
  sd: {
    "push.reply.body": "اسڪول توهان جي پڇا جو جواب ڏنو آهي.",
    "push.status.body": "توهان جي درخواست هاڻي: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "ڏٺي پئي وڃي",
    "stage.visit_scheduled": "ملاقات طئي ٿي",
    "stage.offered": "سيٽ ڏني وئي",
    "stage.waitlisted": "انتظار جي فهرست ۾",
    "stage.accepted": "قبول ڪئي وئي",
    "stage.declined": "سيٽ نه ملي",
  },
  ta: {
    "push.reply.body": "பள்ளி உங்கள் விசாரணைக்குப் பதிலளித்துள்ளது.",
    "push.status.body": "உங்கள் விண்ணப்பம் இப்போது: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "பரிசீலிக்கப்படுகிறது",
    "stage.visit_scheduled": "சந்திப்பு ஏற்பாடு",
    "stage.offered": "இடம் வழங்கப்பட்டது",
    "stage.waitlisted": "காத்திருப்புப் பட்டியலில்",
    "stage.accepted": "ஏற்கப்பட்டது",
    "stage.declined": "இடம் கிடைக்கவில்லை",
  },
  te: {
    "push.reply.body": "పాఠశాల మీ విచారణకు బదులిచ్చింది.",
    "push.status.body": "మీ దరఖాస్తు ఇప్పుడు: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "పరిశీలనలో ఉంది",
    "stage.visit_scheduled": "సందర్శన ఖరారైంది",
    "stage.offered": "సీటు ఇచ్చారు",
    "stage.waitlisted": "వెయిటింగ్ జాబితాలో",
    "stage.accepted": "అంగీకరించారు",
    "stage.declined": "సీటు రాలేదు",
  },
  ur: {
    "push.reply.body": "اسکول نے آپ کے استفسار کا جواب دیا ہے۔",
    "push.status.body": "آپ کی درخواست اب: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "دیکھی جا رہی ہے",
    "stage.visit_scheduled": "ملاقات طے ہو گئی",
    "stage.offered": "نشست دی گئی",
    "stage.waitlisted": "انتظار کی فہرست میں",
    "stage.accepted": "قبول کر لی گئی",
    "stage.declined": "نشست نہیں ملی",
  },
  zh: {
    "push.reply.body": "学校已回复你的咨询。",
    "push.status.body": "你的申请现在：{stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "审核中",
    "stage.visit_scheduled": "已安排参观",
    "stage.offered": "已给出学位",
    "stage.waitlisted": "在候补名单",
    "stage.accepted": "已接受",
    "stage.declined": "未获学位",
  },
};
// ==== END push words ====

function words(language: string, key: string): string {
  const lang = PUSH_WORDS[language] ?? {};
  return lang[key] ?? PUSH_WORDS.en[key] ?? key;
}

// One message for one phone, or null when there is nothing worth sending.
function pushMessage(row: any): any | null {
  const language = String(row?.language ?? "en");
  const school = String(row?.school_name ?? "").trim();
  const title = school || words(language, "push.fallback.title");
  let body = "";
  if (row?.kind === "enquiry_reply") {
    body = words(language, "push.reply.body");
  } else if (row?.kind === "application_status") {
    const stage = words(language, `stage.${row?.status}`);
    body = words(language, "push.status.body").replace("{stage}", stage);
  } else {
    return null;
  }
  return {
    to: row.token,
    title,
    body,
    sound: "default",
    // "default" is the channel the app makes for itself when it registers, so these arrive as Kidscover's own
    // notifications and a person can turn them down without turning down everything else.
    channelId: "default",
    // High, because a phone left alone holds ordinary notifications back until it next wakes - sometimes for hours.
    // These are rare and always wanted: a school has written back, or an application has moved on.
    priority: "high",
    data: { kind: row.kind, notificationId: row.notification_id },
  };
}

const chunk = <T>(items: T[], size = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

// Expo answers with one result per message, in the same order.
function readExpoAnswer(answer: any, sent: any[]): { deadTokens: string[]; failed: Set<number> } {
  const deadTokens: string[] = [];
  const failed = new Set<number>();
  const results = Array.isArray(answer?.data) ? answer.data : [];
  sent.forEach((message, i) => {
    const result = results[i];
    if (!result || result.status !== "ok") {
      const reason = result?.details?.error ?? "";
      if (reason === "DeviceNotRegistered") deadTokens.push(message.to);
      else failed.add(message.data.notificationId);
    }
  });
  return { deadTokens, failed };
}

type Deps = {
  env: { get(name: string): string | undefined };
  fetch: typeof fetch;
  createClient: (url: string, key: string, options?: any) => any;
};

function createHandler(deps: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ ok: false, code: "bad_request" }, 405);
    try {
      const secretKey = deps.env.get("SB_SECRET_KEY") ?? deps.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      if (!secretKey) return json({ ok: false, code: "not_configured" });
      const admin = deps.createClient(deps.env.get("SUPABASE_URL") ?? "", secretKey, { auth: { persistSession: false } });

      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!token) return json({ ok: false, code: "sign_in" }, 401);
      if (token !== secretKey) {
        const { data: who, error } = await admin.auth.getUser(token);
        if (error || !who?.user) return json({ ok: false, code: "sign_in" }, 401);
        const { data: profile } = await admin.from("profiles").select("role").eq("id", who.user.id).maybeSingle();
        if (profile?.role !== "admin" && profile?.role !== "school_admin") return json({ ok: false, code: "not_allowed" }, 403);
      }

      const { data: rows, error: claimErr } = await admin.rpc("claim_push_batch", { p_limit: 200 });
      if (claimErr) {
        const missing = /claim_push_batch|schema cache|PGRST202/i.test(String(claimErr.message ?? ""));
        return json({ ok: false, code: missing ? "not_configured" : "failed" });
      }
      const messages = (rows ?? []).map(pushMessage).filter(Boolean) as any[];
      if (messages.length === 0) return json({ ok: true, sent: 0, dropped: 0 });

      const expoToken = deps.env.get("EXPO_ACCESS_TOKEN") ?? "";
      const dead: string[] = [];
      const failed = new Set<number>();
      let sentCount = 0;

      for (const batch of chunk(messages)) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
        try {
          const res = await deps.fetch(EXPO_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              ...(expoToken ? { Authorization: `Bearer ${expoToken}` } : {}),
            },
            body: JSON.stringify(batch),
            signal: ctrl.signal,
          });
          const text = await res.text();
          if (!res.ok) {
            batch.forEach((m) => failed.add(m.data.notificationId));
            continue;
          }
          let answer: any = null;
          try { answer = JSON.parse(text); } catch { /* handled below */ }
          if (!answer) {
            batch.forEach((m) => failed.add(m.data.notificationId));
            continue;
          }
          const read = readExpoAnswer(answer, batch);
          dead.push(...read.deadTokens);
          read.failed.forEach((id) => failed.add(id));
          sentCount += batch.length - read.failed.size;
        } catch {
          batch.forEach((m) => failed.add(m.data.notificationId));
        } finally {
          clearTimeout(timer);
        }
      }

      for (const t of [...new Set(dead)]) await admin.rpc("forget_push_token", { p_token: t });
      // Anything that reached Expo (or has nowhere left to go) is done; the rest is tried again on the next run.
      const done = [...new Set(messages.map((m) => m.data.notificationId).filter((id) => !failed.has(id)))];
      if (done.length) await admin.rpc("finish_push", { p_ids: done });

      return json({ ok: true, sent: sentCount, dropped: dead.length, retrying: failed.size });
    } catch (_err) {
      return json({ ok: false, code: "failed" }, 500);
    }
  };
}

// ==== END testable logic ====

Deno.serve(createHandler({ env: Deno.env, fetch, createClient }));
