/**
 * پنل آموزشی جامع
 * طراح: نادر اکشیک
 *
 * یک Cloudflare Worker کامل شامل:
 *  - پنل معلم (ورود/خروج، تغییر رمز عبور، تم روشن/تاریک)
 *  - مدیریت دانش‌آموزان با لینک اختصاصی
 *  - آزمون‌سازی با انواع سوال (تشریحی، چهارگزینه‌ای، صحیح/غلط، کوتاه‌پاسخ)
 *  - سربرگ کامل آزمون (نام مدرسه، نام آموزگار، نام آزمون، مدت زمان آزمون به دقیقه)
 *  - انتخاب مقطع تحصیلی (ابتدایی توصیفی / متوسطه اول و دوم نمره‌ای)
 *  - تایمر معکوس برای دانش‌آموز (Countdown Timer)
 *  - ویرایشگر غنی سوال (علائم ریاضی، کسر، تقسیم چکشی، اشکال هندسی SVG، عکس)
 *  - صفحه آزمون دانش‌آموز با سوال امنیتی و نمایش تایمر
 *  - تصحیح و بازخورد:
 *    * ابتدایی: توصیفی (خیلی خوب، خوب، قابل‌قبول، نیاز به تلاش)
 *    * متوسطه اول و دوم: نمره‌ای (عددی با اعشار) - نمره کل از 20
 *  - پاسخنامه‌ها با وضعیت‌های مختلف
 *  - برنامه هفتگی با خروجی Word/PDF/چاپ و ذخیره در KV
 *  - جدول‌ساز حرفه‌ای با خروجی اکسل RTL و میانگین‌گیری
 *  - اسکنر حرفه‌ای (مشابه CamScanner) با فیلترهای متنوع
 *  - کاهش حجم عکس با کیفیت و فرمت‌های مختلف
 *  - برش عکس با نسبت‌های مختلف (پشتیبانی از لمس برای گوشی)
 *  - تبدیل PDF به عکس با انتخاب صفحات و DPI
 *  - چت AI با Groq (حالت‌های مختلف)
 *  - ترجمه متن با MyMemory
 *  - ذخیره‌سازی در Cloudflare KV (binding: EXAM_KV)
 */

const APP_TITLE = "پنل آموزشی جامع";
const APP_DESIGNER = "طراح: نادر اکشیک";

const DEFAULT_META = {
  school: "",
  teacher: "",
  examName: "",
  examDuration: "30",
  gradeLevel: "elementary",
};

const QUESTION_TYPES = {
  descriptive: "تشریحی",
  multiple: "چهارگزینه‌ای",
  truefalse: "صحیح / غلط",
  short: "کوتاه‌پاسخ",
};

/* ------------------------- ابزارهای کمکی ------------------------- */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const FA_DIGITS_SRV = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
function toFaDigitsSrv(s) {
  return String(s == null ? "" : s).replace(/[0-9]/g, (d) => FA_DIGITS_SRV[+d]);
}

function sanitizeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/<\s*\/?\s*(script|iframe|object|embed|link|meta|style)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

function uuid() {
  return crypto.randomUUID();
}

function parseCookies(req) {
  const out = {};
  const c = req.headers.get("cookie") || "";
  c.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getTeacherHash(env) {
  return await env.EXAM_KV.get("teacher_pass");
}

async function isTeacher(req, env) {
  const stored = await getTeacherHash(env);
  if (!stored) return false;
  const cookies = parseCookies(req);
  return Boolean(cookies.t_auth && cookies.t_auth === stored);
}

async function getMeta(env) {
  const raw = await env.EXAM_KV.get("meta");
  return raw ? { ...DEFAULT_META, ...JSON.parse(raw) } : { ...DEFAULT_META };
}

async function getQuestions(env) {
  const raw = await env.EXAM_KV.get("questions");
  return raw ? JSON.parse(raw) : [];
}

async function listStudents(env) {
  const out = [];
  let cursor;
  do {
    const res = await env.EXAM_KV.list({ prefix: "student:", cursor });
    const values = await Promise.all(res.keys.map((k) => env.EXAM_KV.get(k.name)));
    for (const v of values) {
      if (v) out.push(JSON.parse(v));
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

function getScheduleHtml(data) {
  const school = data.school || 'مدرسه';
  const year = data.year || '';
  const topic = data.topic || '';
  const principal = data.principal || '';
  const cls = data.cls || '';
  const teacher = data.teacher || '';
  const days = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه'];
  const zang = ['زنگ اول', 'زنگ دوم', 'زنگ سوم', 'زنگ چهارم', 'زنگ پنجم'];
  const dayColors = [
    'linear-gradient(135deg,#ff9a9e,#fecfef)',
    'linear-gradient(135deg,#fddb92,#d1fdff)',
    'linear-gradient(135deg,#a1ffce,#faffbd)',
    'linear-gradient(135deg,#e0c3fc,#8ec5fc)',
    'linear-gradient(135deg,#a8edea,#fed6e3)'
  ];
  const accentColors = ['#ef4444','#f59e0b','#10b981','#8b5cf6','#06b6d4'];
  const cellColors = ['#fef2f2','#fffbeb','#f0fdf4','#f5f3ff','#ecfeff'];
  
  let style = `<style>
    @font-face{font-family:"BNazanin";src:url(https://cdn.jsdelivr.net/gh/naderuser/bnazanin@main/BNazanin.ttf)}
    body{direction:rtl;font-family:"BNazanin",tahoma,Arial;padding:30px;background:#f8fafc}
    .header{text-align:center;padding:20px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border-radius:20px;margin-bottom:20px}
    .header h1{font-size:24px;margin:0 0 10px;font-weight:800;letter-spacing:.3px}.header p{margin:5px 0;font-size:14px}
    table{width:100%;border-collapse:separate;border-spacing:0;border-radius:18px;overflow:hidden;box-shadow:0 8px 24px rgba(15,23,42,.10);border:1px solid #e2e8f0}
    th{padding:14px 8px;font-size:14px;font-weight:800;text-align:center;border-bottom:2px solid #e2e8f0;border-left:1px solid #e2e8f0}
    td{padding:14px 10px;text-align:center;font-size:13px;min-height:50px;font-weight:600;color:#1e293b;border-bottom:1px solid #eef2f6;border-left:1px solid #eef2f6}
    tr:last-child td{border-bottom:none}
    .daylabel{border-right:5px solid;font-weight:800}
    .footer{text-align:center;margin-top:30px;padding:20px;border-top:2px dashed #ddd}
  </style>`;
  
  let header = `<div class="header"><h1>⭐ برنامه هفتگی کلاس ⭐</h1><p>🏫 ${esc(school)} | سال تحصیلی: ${esc(year)}</p><p>کلاس: ${esc(cls)} | آموزگار: ${esc(teacher)}</p></div>`;
  
  let table = '<table><tr><th style="background:linear-gradient(135deg,#1e293b,#334155);color:#fff;border-bottom:none">روز / زنگ</th>';
  for (let z = 0; z < 5; z++) {
    table += `<th style="background:#f8fafc;color:#334155">🔔 ${zang[z]}</th>`;
  }
  table += '</tr>';
  
  for (let d = 0; d < 5; d++) {
    table += `<tr><td class="daylabel" style="background:${cellColors[d]};border-right-color:${accentColors[d]}">${days[d]}</td>`;
    for (let i = 1; i <= 5; i++) {
      const key = `c${d}${i}`;
      const val = (data.cells && data.cells[key]) || '&nbsp;';
      table += `<td style="background:${cellColors[d]}"><div style="min-height:40px">${val}</div></td>`;
    }
    table += '</tr>';
  }
  table += '</table>';
  
  const footer = ``;
  return `<html><head><meta charset="utf-8">${style}</head><body>${header}${table}${footer}</body></html>`;
}

function safeQuestion(q) {
  return { 
    id: q.id, 
    type: q.type, 
    rich: Boolean(q.rich), 
    text: q.text, 
    options: q.options || [], 
    image: q.image || "",
    imageWidth: q.imageWidth || 320,
    weight: q.weight || 1
  };
}

/* ------------------------- روتر اصلی ------------------------- */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === "/api/classroom/ws") return await handleClassroomSocket(req, env, url);

      if (path.startsWith("/api/")) return await handleApi(req, env, url, path);

      if (path.startsWith("/s/")) {
        const id = decodeURIComponent(path.slice(3));
        return await studentPage(env, id);
      }

      if (path.startsWith("/w/")) {
        const id = decodeURIComponent(path.slice(3));
        return await workSheetPage(env, id);
      }

      if (path.startsWith("/class/")) {
        const id = decodeURIComponent(path.slice(7));
        return await studentClassPage(env, id);
      }

      if (path === "/teacher" || path === "/teacher/") return html(teacherPage());

      if (path === "/") return html(landingPage());

      return html(notFoundPage(), 404);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message ? err.message : err) }, 500);
    }
  },
};

/* ------------------------- کلاس آنلاین (Durable Object) -------------------------
 * برای فعال شدن این بخش باید در wrangler.toml موارد زیر اضافه شود:
 *
 * [[durable_objects.bindings]]
 * name = "CLASSROOM"
 * class_name = "ClassRoom"
 *
 * [[migrations]]
 * tag = "v1"
 * new_sqlite_classes = ["ClassRoom"]
 *
 * توجه: از مدتی پیش Durable Objects (نوع SQLite) روی پلن رایگان Workers هم در دسترس
 * است و نیازی به پلن Paid نیست؛ فقط باید حتماً از "new_sqlite_classes" (نه
 * "new_classes") در migrations استفاده شود تا با پلن رایگان سازگار باشد.
 * -------------------------------------------------------------------------------- */

async function handleClassroomSocket(req, env, url) {
  const role = url.searchParams.get("role") === "teacher" ? "teacher" : "student";

  // مسیر تشخیصی: بدون WebSocket، فقط بررسی می‌کند که آیا اتصال باید موفق باشد یا نه
  // و در صورت خطا، دلیل دقیق را برمی‌گرداند (برای نمایش پیام مشخص به‌جای «قطع شد»).
  if (url.searchParams.get("check") === "1") {
    if (role === "teacher") {
      if (!(await isTeacher(req, env))) return json({ ok: false, error: "برای کلاس آنلاین باید ابتدا در پنل معلم وارد شوید." }, 401);
    } else {
      const id = url.searchParams.get("id") || "";
      const rec = id ? await env.EXAM_KV.get("student:" + id) : null;
      if (!rec) return json({ ok: false, error: "این لینک کلاس آنلاین معتبر نیست. لینک را از پنل معلم دوباره کپی کنید." }, 404);
    }
    if (!env.CLASSROOM) {
      return json({ ok: false, error: "کلاس آنلاین روی این ورکر فعال نشده است. باید در wrangler.toml بخش durable_objects و migrations برای ClassRoom اضافه و دوباره deploy شود." }, 500);
    }
    return json({ ok: true });
  }

  if (req.headers.get("upgrade") !== "websocket") {
    return json({ ok: false, error: "این مسیر فقط برای اتصال WebSocket است" }, 400);
  }

  if (role === "teacher") {
    if (!(await isTeacher(req, env))) return json({ ok: false, error: "دسترسی غیرمجاز" }, 401);
  } else {
    const id = url.searchParams.get("id") || "";
    const rec = await env.EXAM_KV.get("student:" + id);
    if (!rec) return json({ ok: false, error: "لینک نامعتبر است" }, 404);
  }

  if (!env.CLASSROOM) {
    return json({ ok: false, error: "کلاس آنلاین روی این ورکر فعال نشده (Durable Object تنظیم نشده)" }, 500);
  }

  const roomId = env.CLASSROOM.idFromName("main");
  const stub = env.CLASSROOM.get(roomId);
  return stub.fetch(req);
}

export class ClassRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // ws -> { role, id, name }
    this.strokes = []; // تاریخچه تخته هوشمند برای سینک اعضای جدید
    this.chat = []; // آخرین پیام‌های چت
    this.boardBg = null; // صفحه‌ی PDF فعلی روی تخته (data URL) یا null
    this.boardBgW = 900;
    this.boardBgH = 560;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }
    const role = url.searchParams.get("role") === "teacher" ? "teacher" : "student";
    const id = url.searchParams.get("id") || "";
    const name = (url.searchParams.get("name") || (role === "teacher" ? "معلم" : "دانش‌آموز")).slice(0, 60);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const session = { role, id, name };
    this.sessions.set(server, session);

    server.send(JSON.stringify({
      type: "init",
      role,
      strokes: this.strokes,
      boardBg: this.boardBg,
      boardBgW: this.boardBgW,
      boardBgH: this.boardBgH,
      chat: this.chat.slice(-50),
      participants: this.participantList(),
    }));

    this.broadcast({ type: "presence", event: "join", role, name, participants: this.participantList() }, server);

    server.addEventListener("message", (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      this.handleMessage(server, session, msg);
    });

    const onClose = () => {
      if (!this.sessions.has(server)) return;
      this.sessions.delete(server);
      this.broadcast({ type: "presence", event: "leave", role: session.role, name: session.name, participants: this.participantList() });
    };
    server.addEventListener("close", onClose);
    server.addEventListener("error", onClose);

    return new Response(null, { status: 101, webSocket: client });
  }

  participantList() {
    return Array.from(this.sessions.values()).map((s) => ({ role: s.role, name: s.name, id: s.id }));
  }

  handleMessage(sender, session, msg) {
    if (!msg || typeof msg !== "object") return;

    // فقط معلم اجازه‌ی رسم روی تخته هوشمند و پخش صدا را دارد
    if (msg.type === "draw" && session.role === "teacher") {
      this.strokes.push(msg.stroke);
      if (this.strokes.length > 3000) this.strokes.splice(0, 1000);
      this.broadcast({ type: "draw", stroke: msg.stroke }, sender);
      return;
    }

    if (msg.type === "clear" && session.role === "teacher") {
      this.strokes = [];
      this.broadcast({ type: "clear" }, sender);
      return;
    }

    if (msg.type === "board-bg" && session.role === "teacher") {
      if (msg.data && msg.data.length > 4_000_000) {
        try { sender.send(JSON.stringify({ type: "error", message: "حجم تصویر صفحه‌ی PDF برای ارسال زنده خیلی زیاد است." })); } catch {}
        return;
      }
      this.boardBg = msg.data || null;
      this.boardBgW = msg.w || 900;
      this.boardBgH = msg.h || 560;
      this.strokes = []; // با تغییر صفحه‌ی PDF، یادداشت‌های قبلی روی صفحه‌ی قبل پاک می‌شود
      this.broadcast({ type: "board-bg", data: this.boardBg, w: this.boardBgW, h: this.boardBgH }, sender);
      return;
    }

    if (msg.type === "audio" && session.role === "teacher") {
      // چانک صوتی فشرده (base64) برای پخش تقریباً زنده برای دانش‌آموزان
      this.broadcast({ type: "audio", data: msg.data, mime: msg.mime || "audio/webm" }, sender);
      return;
    }

    if (msg.type === "video-frame" && session.role === "teacher") {
      // فریم تصویر معلم (JPEG با کیفیت پایین) برای تماس تصویری ساده‌ی زنده
      this.broadcast({ type: "video-frame", data: msg.data }, sender);
      return;
    }

    if (msg.type === "video-stop" && session.role === "teacher") {
      this.broadcast({ type: "video-stop" }, sender);
      return;
    }

    if (msg.type === "chat") {
      const entry = {
        from: session.name,
        role: session.role,
        text: String(msg.text || "").slice(0, 1000),
        ts: Date.now(),
      };
      if (!entry.text) return;
      this.chat.push(entry);
      if (this.chat.length > 200) this.chat.splice(0, 100);
      this.broadcast({ type: "chat", entry });
      return;
    }

    if (msg.type === "file") {
      // ارسال فایل (عکس/سند) بین معلم و دانش‌آموزان - فقط زنده پخش می‌شود، در تاریخچه ذخیره نمی‌شود
      const name = String(msg.name || "file").slice(0, 200);
      const mime = String(msg.mime || "application/octet-stream").slice(0, 100);
      const data = String(msg.data || "");
      if (!data || data.length > 3_000_000) return; // حداکثر ~2 مگابایت فایل (بعد از base64)
      this.broadcast({ type: "file", from: session.name, role: session.role, name, mime, data, ts: Date.now() });
      return;
    }

    if (msg.type === "raise-hand" && session.role === "student") {
      this.broadcast({ type: "raise-hand", name: session.name });
      return;
    }
  }

  broadcast(payload, exclude) {
    const data = JSON.stringify(payload);
    for (const ws of this.sessions.keys()) {
      if (ws === exclude) continue;
      try { ws.send(data); } catch { /* اتصال قطع شده - نادیده گرفته می‌شود */ }
    }
  }
}

/* ------------------------- API ------------------------- */

async function handleApi(req, env, url, path) {
  const method = req.method;

  /* --- تشخیصی موقت: بررسی وجود کلید Gemini (بدون افشای مقدار) --- */
  if (path === "/api/debug/env-check" && method === "GET") {
    return json({
      hasGeminiKey: typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.length > 0,
      geminiKeyLength: env.GEMINI_API_KEY ? env.GEMINI_API_KEY.length : 0,
    });
  }

  /* --- معلم: ورود/خروج --- */
  if (path === "/api/teacher/login" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    const pass = String(body.password || "");
    const stored = await getTeacherHash(env);
    const cookieFor = (h) => `t_auth=${h}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
    if (!stored) {
      if (pass.length < 4) return json({ ok: false, error: "رمز باید حداقل ۴ کاراکتر باشد" }, 400);
      const hash = await sha256(pass);
      await env.EXAM_KV.put("teacher_pass", hash);
      return json({ ok: true, created: true }, 200, { "set-cookie": cookieFor(hash) });
    }
    const hash = await sha256(pass);
    if (hash === stored) return json({ ok: true }, 200, { "set-cookie": cookieFor(hash) });
    return json({ ok: false, error: "رمز عبور اشتباه است" }, 401);
  }

  if (path === "/api/teacher/logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": "t_auth=; Path=/; Max-Age=0" });
  }

  if (path === "/api/teacher/state" && method === "GET") {
    const stored = await getTeacherHash(env);
    return json({ ok: true, auth: await isTeacher(req, env), configured: Boolean(stored) });
  }

  /* --- آزمون دانش‌آموز (عمومی) --- */
  if (path.startsWith("/api/exam/")) {
    const rest = path.slice("/api/exam/".length);
    const parts = rest.split("/");
    const id = decodeURIComponent(parts[0] || "");
    const studentRaw = await env.EXAM_KV.get("student:" + id);
    if (!studentRaw) return json({ ok: false, error: "لینک نامعتبر است" }, 404);

    if (parts[1] === "submit" && method === "POST") {
      const existing = await env.EXAM_KV.get("submission:" + id);
      if (existing) return json({ ok: false, error: "این آزمون قبلاً ثبت شده است" }, 409);
      
      const body = await req.json().catch(() => ({}));
      const meta = await getMeta(env);
      const questions = await getQuestions(env);
      
      const durationMinutes = parseInt(meta.examDuration) || 30;
      const endTime = Date.now() + (durationMinutes * 60 * 1000);
      
      const submission = {
        uuid: id,
        student: {
          name: String(body.name || "").slice(0, 120),
          fatherName: String(body.fatherName || "").slice(0, 120),
          nationalId: String(body.nationalId || "").slice(0, 30),
          courseName: String(body.courseName || "").slice(0, 120),
          examDate: String(body.examDate || "").slice(0, 40),
        },
        answers: body.answers || {},
        photoAnswers: body.photoAnswers || {},
        meta,
        questionsSnapshot: questions,
        submittedAt: Date.now(),
        endTime: endTime,
        grading: null,
      };
      await env.EXAM_KV.put("submission:" + id, JSON.stringify(submission));
      return json({ ok: true });
    }

    if (method === "GET") {
      const meta = await getMeta(env);
      const subRaw = await env.EXAM_KV.get("submission:" + id);
      const st = JSON.parse(studentRaw);
      
      if (subRaw) {
        const sub = JSON.parse(subRaw);
        const resultQuestions = (sub.questionsSnapshot || []).map(safeQuestion);
        
        const now = Date.now();
        const remaining = Math.max(0, Math.floor((sub.endTime - now) / 1000));
        const isExpired = remaining <= 0;
        
        return json({
          ok: true,
          meta,
          submitted: true,
          timeCheck: true,
          remaining: remaining,
          isExpired: isExpired,
          result: {
            questions: resultQuestions,
            answers: sub.answers || {},
            student: sub.student || {},
            grading: sub.grading || null,
          },
        });
      }
      const questions = (await getQuestions(env)).map(safeQuestion);
      const durationMinutes = parseInt(meta.examDuration) || 30;
      
      return json({ 
        ok: true, 
        meta, 
        submitted: false, 
        questions, 
        label: st.label || "", 
        timeCheck: true,
        duration: durationMinutes * 60
      });
    }
  }

  /* --- کاربرگ دانش‌آموز (عمومی) --- */
  if (path.startsWith("/api/worksheet/")) {
    const rest = path.slice("/api/worksheet/".length);
    const parts = rest.split("/");
    const id = decodeURIComponent(parts[0] || "");
    const studentRaw = await env.EXAM_KV.get("student:" + id);
    if (!studentRaw) return json({ ok: false, error: "لینک نامعتبر است" }, 404);
    const st = JSON.parse(studentRaw);

    if (parts[1] === "submit" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const photos = Array.isArray(body.photos) ? body.photos.slice(0, 6) : [];
      for (const p of photos) {
        if (typeof p !== "string" || !p.startsWith("data:image/")) return json({ ok: false, error: "فرمت عکس نامعتبر است" }, 400);
        if (p.length > 2_800_000) return json({ ok: false, error: "حجم یکی از عکس‌ها بیش از حد مجاز است (حداکثر ۲ مگابایت)" }, 400);
      }
      if (!photos.length) return json({ ok: false, error: "حداقل یک عکس باید بارگذاری شود" }, 400);
      const raw = await env.EXAM_KV.get("worksheet:" + id);
      const rec = raw ? JSON.parse(raw) : { uuid: id };
      rec.studentFiles = photos;
      rec.studentUploadedAt = Date.now();
      await env.EXAM_KV.put("worksheet:" + id, JSON.stringify(rec));
      return json({ ok: true });
    }

    if (method === "GET") {
      const raw = await env.EXAM_KV.get("worksheet:" + id);
      const rec = raw ? JSON.parse(raw) : {};
      return json({
        ok: true,
        label: st.label || "",
        teacherFile: rec.teacherFile || "",
        teacherFileName: rec.teacherFileName || "",
        teacherFileType: rec.teacherFileType || "",
        teacherUploadedAt: rec.teacherUploadedAt || null,
        studentFiles: rec.studentFiles || [],
        studentUploadedAt: rec.studentUploadedAt || null,
        feedback: rec.feedback || "",
        feedbackAt: rec.feedbackAt || null,
      });
    }
  }

  /* --- از این به بعد فقط معلم --- */
  if (path.startsWith("/api/teacher/")) {
    if (!(await isTeacher(req, env))) return json({ ok: false, error: "دسترسی غیرمجاز" }, 401);

    if (path === "/api/teacher/password" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const np = String(body.newPassword || "");
      if (np.length < 4) return json({ ok: false, error: "رمز جدید باید حداقل ۴ کاراکتر باشد" }, 400);
      const hash = await sha256(np);
      await env.EXAM_KV.put("teacher_pass", hash);
      return json({ ok: true }, 200, { "set-cookie": `t_auth=${hash}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` });
    }

    if (path === "/api/teacher/schedule" && method === "GET") {
      const raw = await env.EXAM_KV.get("schedule_data");
      return json({ ok: true, data: raw ? JSON.parse(raw) : null });
    }

    if (path === "/api/teacher/schedule" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      await env.EXAM_KV.put("schedule_data", JSON.stringify(body.data || {}));
      return json({ ok: true });
    }

    /* --- دفتر مدیریت کلاسی: ذخیره/بازیابی عمومی --- */
    if (path === "/api/teacher/lb-save" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const key = String(body.key || "").slice(0, 200);
      if (!key) return json({ ok: false, error: "کلید نامعتبر است" }, 400);
      await env.EXAM_KV.put("lbdata:" + key, JSON.stringify(body.value ?? null));
      return json({ ok: true });
    }

    if (path === "/api/teacher/lb-load" && method === "GET") {
      const key = url.searchParams.get("key") || "";
      if (!key) return json({ ok: false, error: "کلید نامعتبر است" }, 400);
      const raw = await env.EXAM_KV.get("lbdata:" + key);
      return json({ ok: true, value: raw ? JSON.parse(raw) : null });
    }

    if (path.startsWith("/api/teacher/worksheet/") && path.endsWith("/feedback") && method === "POST") {
      const id = decodeURIComponent(path.slice("/api/teacher/worksheet/".length, -"/feedback".length));
      const studentRaw = await env.EXAM_KV.get("student:" + id);
      if (!studentRaw) return json({ ok: false, error: "دانش‌آموز پیدا نشد" }, 404);
      const body = await req.json().catch(() => ({}));
      const raw = await env.EXAM_KV.get("worksheet:" + id);
      const rec = raw ? JSON.parse(raw) : { uuid: id };
      rec.feedback = String(body.feedback || "").slice(0, 5000);
      rec.feedbackAt = Date.now();
      await env.EXAM_KV.put("worksheet:" + id, JSON.stringify(rec));
      return json({ ok: true });
    }

    if (path.startsWith("/api/teacher/worksheet/") && method === "GET") {
      const id = decodeURIComponent(path.slice("/api/teacher/worksheet/".length));
      const raw = await env.EXAM_KV.get("worksheet:" + id);
      const rec = raw ? JSON.parse(raw) : {};
      return json({ ok: true, worksheet: rec });
    }

    if (path.startsWith("/api/teacher/worksheet/") && method === "POST") {
      const id = decodeURIComponent(path.slice("/api/teacher/worksheet/".length));
      const studentRaw = await env.EXAM_KV.get("student:" + id);
      if (!studentRaw) return json({ ok: false, error: "دانش‌آموز پیدا نشد" }, 404);
      const body = await req.json().catch(() => ({}));
      const fileDataUrl = String(body.fileDataUrl || "");
      if (!fileDataUrl.startsWith("data:image/") && !fileDataUrl.startsWith("data:application/pdf")) {
        return json({ ok: false, error: "فرمت فایل باید عکس یا PDF باشد" }, 400);
      }
      if (fileDataUrl.length > 4_500_000) return json({ ok: false, error: "حجم فایل بیش از حد مجاز است (حداکثر حدود ۴ مگابایت)" }, 400);
      const raw = await env.EXAM_KV.get("worksheet:" + id);
      const rec = raw ? JSON.parse(raw) : { uuid: id };
      rec.teacherFile = fileDataUrl;
      rec.teacherFileName = String(body.fileName || "").slice(0, 200);
      rec.teacherFileType = fileDataUrl.startsWith("data:application/pdf") ? "pdf" : "image";
      rec.teacherUploadedAt = Date.now();
      await env.EXAM_KV.put("worksheet:" + id, JSON.stringify(rec));
      return json({ ok: true });
    }

    if (path.startsWith("/api/teacher/worksheet/") && method === "DELETE") {
      const id = decodeURIComponent(path.slice("/api/teacher/worksheet/".length));
      const raw = await env.EXAM_KV.get("worksheet:" + id);
      if (raw) {
        const rec = JSON.parse(raw);
        delete rec.teacherFile;
        delete rec.teacherFileName;
        delete rec.teacherFileType;
        delete rec.teacherUploadedAt;
        await env.EXAM_KV.put("worksheet:" + id, JSON.stringify(rec));
      }
      return json({ ok: true });
    }

    if (path === "/api/teacher/students" && method === "GET") {
      const students = await listStudents(env);
      const subs = await Promise.all(students.map((s) => env.EXAM_KV.get("submission:" + s.uuid)));
      const withStatus = students.map((s, idx) => {
        const subRaw = subs[idx];
        let status = "pending";
        if (subRaw) {
          const sub = JSON.parse(subRaw);
          status = sub.grading && sub.grading.graded ? "graded" : "submitted";
        }
        return { ...s, status };
      });
      return json({ ok: true, students: withStatus });
    }

    if (path === "/api/teacher/students" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = uuid();
      let photo = "";
      if (typeof body.photo === "string" && body.photo.startsWith("data:image/")) {
        if (body.photo.length > 2_800_000) return json({ ok: false, error: "حجم عکس پروفایل بیش از حد مجاز است (حداکثر ۲ مگابایت)" }, 400);
        photo = body.photo;
      }
      const rec = { uuid: id, label: String(body.label || "").slice(0, 120), photo, createdAt: Date.now() };
      await env.EXAM_KV.put("student:" + id, JSON.stringify(rec));
      return json({ ok: true, student: rec });
    }

    if (path.startsWith("/api/teacher/students/") && method === "PATCH") {
      const id = decodeURIComponent(path.slice("/api/teacher/students/".length));
      const raw = await env.EXAM_KV.get("student:" + id);
      if (!raw) return json({ ok: false, error: "دانش‌آموز پیدا نشد" }, 404);
      const rec = JSON.parse(raw);
      const body = await req.json().catch(() => ({}));
      if (typeof body.photo === "string") {
        if (body.photo && body.photo.startsWith("data:image/")) {
          if (body.photo.length > 2_800_000) return json({ ok: false, error: "حجم عکس پروفایل بیش از حد مجاز است (حداکثر ۲ مگابایت)" }, 400);
          rec.photo = body.photo;
        } else if (body.photo === "") {
          rec.photo = "";
        }
      }
      if (typeof body.label === "string") rec.label = body.label.slice(0, 120);
      await env.EXAM_KV.put("student:" + id, JSON.stringify(rec));
      return json({ ok: true, student: rec });
    }

    if (path.startsWith("/api/teacher/students/") && method === "DELETE") {
      const id = decodeURIComponent(path.slice("/api/teacher/students/".length));
      await env.EXAM_KV.delete("student:" + id);
      await env.EXAM_KV.delete("submission:" + id);
      return json({ ok: true });
    }

    if (path === "/api/teacher/questions" && method === "GET") {
      return json({ ok: true, meta: await getMeta(env), questions: await getQuestions(env) });
    }

    if (path === "/api/teacher/questions" && method === "PUT") {
      const body = await req.json().catch(() => ({}));
      const questions = (Array.isArray(body.questions) ? body.questions : []).map((q, i) => {
        const type = QUESTION_TYPES[q.type] ? q.type : "descriptive";
        const rich = type === "descriptive" && Boolean(q.rich);
        return {
          id: q.id || uuid(),
          type,
          rich,
          text: rich ? sanitizeHtml(String(q.text || "")) : String(q.text || ""),
          options: Array.isArray(q.options) ? q.options.map((o) => String(o)) : [],
          correct: q.correct == null ? "" : q.correct,
          image: typeof q.image === "string" ? q.image : "",
          imageWidth: Number.isFinite(parseInt(q.imageWidth, 10)) ? Math.min(900, Math.max(80, parseInt(q.imageWidth, 10))) : 320,
          imageAsQuestion: Boolean(q.imageAsQuestion),
          weight: Math.min(20, Math.max(0.5, parseFloat(q.weight) || 1)),
          order: i,
        };
      });
      await env.EXAM_KV.put("questions", JSON.stringify(questions));
      if (body.meta) {
        const meta = { ...DEFAULT_META, ...body.meta };
        await env.EXAM_KV.put("meta", JSON.stringify(meta));
      }
      return json({ ok: true });
    }

    if (path === "/api/teacher/submissions" && method === "GET") {
      const students = await listStudents(env);
      const out = [];
      for (const s of students) {
        const raw = await env.EXAM_KV.get("submission:" + s.uuid);
        if (raw) {
          const sub = JSON.parse(raw);
          sub.label = s.label || "";
          sub.studentPhoto = s.photo || "";
          out.push(sub);
        }
      }
      out.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
      return json({ ok: true, submissions: out });
    }

    if (path === "/api/teacher/grade" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = body.uuid;
      const raw = await env.EXAM_KV.get("submission:" + id);
      if (!raw) return json({ ok: false, error: "پاسخنامه یافت نشد" }, 404);
      const sub = JSON.parse(raw);
      sub.grading = {
        graded: true,
        overall: String(body.overall || ""),
        feedback: body.feedback && typeof body.feedback === "object" ? body.feedback : {},
        marks: body.marks && typeof body.marks === "object" ? body.marks : {},
        gradedAt: Date.now(),
      };
      await env.EXAM_KV.put("submission:" + id, JSON.stringify(sub));
      return json({ ok: true });
    }

    if (path === "/api/teacher/word" && method === "GET") {
      const type = url.searchParams.get("type") || "questions";
      const meta = await getMeta(env);
      if (type === "answers") {
        const id = url.searchParams.get("uuid");
        const raw = await env.EXAM_KV.get("submission:" + id);
        if (!raw) return json({ ok: false, error: "پاسخنامه یافت نشد" }, 404);
        const sub = JSON.parse(raw);
        return wordResponse(answerSheetWord(sub), `پاسخنامه-${sub.student.name || id}.doc`);
      }
      const questions = await getQuestions(env);
      if (type === "examsheet") {
        const raw = await env.EXAM_KV.get("lbdata:examsheet");
        const data = raw ? JSON.parse(raw) : {};
        return wordResponse(examSheetWord(data), "برگه-آزمون-چاپی.doc", "0.6cm");
      }
      return wordResponse(examWord(meta, questions), "برگه-آزمون.doc");
    }

    if (path === "/api/teacher/ai/chat" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const messages = body.messages || [];
      const maxTokens = Math.min(Math.max(parseInt(body.max_tokens, 10) || 1024, 256), 4096);

      const geminiKey = env.GEMINI_API_KEY;
      if (!geminiKey) return json({ error: "کلید GEMINI_API_KEY تنظیم نشده" }, 500);
      // مدل فعلی: gemini-3.6-flash (نسخه‌ی پایدار/GA در سال ۲۰۲۶؛ در صورت بازنشستگی باید به‌روزرسانی شود)
      const geminiModel = "gemini-3.6-flash";
      // تبدیل قالب پیام‌های OpenAI-style به قالب contents مورد نیاز Gemini
      let systemInstruction = "";
      const contents = [];
      for (const m of messages.slice(-10)) {
        if (m.role === "system") { systemInstruction += (systemInstruction ? "\n" : "") + (typeof m.content === "string" ? m.content : ""); continue; }
        const role = m.role === "assistant" ? "model" : "user";
        const parts = [];
        if (typeof m.content === "string") {
          parts.push({ text: m.content });
        } else if (Array.isArray(m.content)) {
          for (const c of m.content) {
            if (c.type === "text") parts.push({ text: c.text });
            else if (c.type === "image_url" && c.image_url?.url) {
              const durl = c.image_url.url;
              const match = /^data:(.+?);base64,(.+)$/.exec(durl);
              if (match) parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
            }
          }
        }
        if (parts.length) contents.push({ role, parts });
      }
      try {
        const aiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents,
              systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
              generationConfig: { maxOutputTokens: maxTokens }
            })
          }
        );
        if (!aiRes.ok) {
          const errText = await aiRes.text();
          return json({ error: "Gemini: " + errText }, aiRes.status);
        }
        const aiData = await aiRes.json();
        const text = aiData.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
        return json({ ok: true, content: text });
      } catch (e) {
        return json({ error: "Error: " + e.message }, 500);
      }
    }
  }

  return json({ ok: false, error: "مسیر یافت نشد" }, 404);
}

/* ------------------------- خروجی Word ------------------------- */

function wordResponse(bodyHtml, filename, margin) {
  const doc =
    `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">` +
    `<head><meta charset="utf-8">` +
    `<style>
      @page { size: A4; margin: ${margin || "1.5cm"}; }
      body { font-family: 'B Nazanin','Tahoma',sans-serif; direction: rtl; font-size: 13pt; }
      .hdr { text-align:center; border-bottom: 2px solid #000; padding-bottom:8px; margin-bottom:14px; }
      .hdr h1 { font-size: 15pt; margin: 2px 0; }
      .hdr h2 { font-size: 12pt; margin: 2px 0; font-weight: normal; }
      .hdr h3 { font-size: 12pt; margin: 2px 0; font-weight: normal; }
      .meta-table { width:100%; mso-table-layout-alt:fixed; border-collapse: collapse; margin-bottom: 14px; }
      .meta-table td { border: 1px solid #000; padding: 6px 8px; }
      table.q { width:100%; mso-table-layout-alt:fixed; border-collapse: collapse; margin-bottom: 10px; }
      table.q td, table.q th { border: 1px solid #000; padding: 6px 8px; vertical-align: top; }
      .qnum { width: 36px; text-align:center; font-weight:bold; }
      .opt { padding: 2px 18px; }
      .ans { min-height: 40px; }
      img { max-width: 900px; }
      .frac{display:inline-block;text-align:center;vertical-align:middle;margin:0 3px}
      .frac .fn{display:block;border-bottom:1.5px solid #000;padding:0 4px}
      .frac .fd{display:block;padding:0 4px}
      .shape{display:inline-block;vertical-align:middle;line-height:1;margin:0 2px}
      .shape svg{display:block}
      .ldiv{border-collapse:collapse;display:inline-table;margin:6px 4px;vertical-align:middle}
      .ldiv td{padding:3px 10px;text-align:center;vertical-align:top}
      .ldiv td.ld-bar{border-right:2px solid #000}
      .ldiv td.ld-top{border-bottom:2px solid #000;min-width:60px;min-height:20px}
      .ldiv .ld-divisor{vertical-align:bottom;padding-bottom:6px;font-weight:bold}
      .ldiv .ld-dividend{padding:2px 6px;text-align:center}
      .ldiv .ld-work{min-height:26px}
      .mt-frac{display:inline-block;text-align:center;vertical-align:middle;margin:0 4px}
      .mt-frac .mt-num{display:block;border-bottom:2px solid #000;padding:0 4px}
      .mt-frac .mt-den{display:block;padding:0 4px}
      .mt-root{display:inline-block;vertical-align:middle;margin:0 4px}
      .mt-root .mt-idx{font-size:.6em;vertical-align:top}
      .mt-root .mt-rad{text-decoration:overline;padding:0 3px}
      .mt-op{display:inline-block;vertical-align:middle;margin:0 4px}
      .mt-op-stack{display:inline-block;text-align:center;vertical-align:middle}
      .mt-op-over,.mt-op-under{display:block;font-size:.55em}
      .mt-op-sign{display:block;font-size:1.6em;line-height:1}
      .mt-op-arg{display:inline-block;vertical-align:middle}
      .mt-lim{display:inline-block;vertical-align:middle;margin:0 4px}
      .mt-lim-stack{display:inline-block;text-align:center;vertical-align:middle}
      .mt-lim-word{display:block;font-size:.7em}
      .mt-lim-under{display:block;font-size:.55em}
      .mt-matrix{border-collapse:collapse;display:inline-table;vertical-align:middle;margin:0 5px;border-left:2px solid #000;border-right:2px solid #000}
      .mt-matrix td{padding:4px 10px;text-align:center}
      .mt-ph{display:inline-block;min-width:16px}
    </style></head><body dir="rtl">` +
    bodyHtml +
    `</body></html>`;
  return new Response(doc, {
    headers: {
      "content-type": "application/msword; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}

function wordHeader(meta, extra = "") {
  let html = `<div class="hdr">`;
  if (meta.school) html += `<h1>${esc(meta.school)}</h1>`;
  if (meta.examName) html += `<h2>${esc(meta.examName)}</h2>`;
  if (meta.teacher) html += `<h3>آموزگار: ${esc(meta.teacher)}</h3>`;
  if (meta.examDuration) html += `<h3>مدت زمان: ${esc(meta.examDuration)} دقیقه</h3>`;
  html += `</div>`;
  return html + extra;
}

function questionBodyWord(q) {
  let inner = `<div><b>${q.rich ? q.text : esc(q.text)}</b> <span style="font-size:11px;color:#666">(وزن: ${q.weight || 1})</span></div>`;
  if (q.image) inner += `<div><img src="${esc(q.image)}" style="width:${q.imageWidth || 320}px;max-width:100%"></div>`;
  if (q.type === "multiple") {
    (q.options || []).forEach((o, oi) => {
      inner += `<div class="opt">${["الف", "ب", "ج", "د"][oi] || oi + 1}) ${esc(o)}</div>`;
    });
  } else if (q.type === "truefalse") {
    inner += `<div class="opt">صحیح ☐&nbsp;&nbsp;&nbsp; غلط ☐</div>`;
  } else if (q.type === "short") {
    inner += `<div class="ans">پاسخ: ...........................................................</div>`;
  } else {
    inner += `<div class="ans">پاسخ:<br><br><br></div>`;
  }
  return inner;
}

function examWord(meta, questions) {
  let body = wordHeader(meta);
  body +=
    `<table class="meta-table">` +
    `<tr><td>نام و نام خانوادگی: ...................</td><td>نام پدر: ...................</td><td>کد ملی: ...................</td></tr>` +
    `<tr><td>نام درس: ...................</td><td>کلاس: ...................</td><td></td></tr>` +
    `</table>`;

  questions.forEach((q, i) => {
    body +=
      `<table class="q"><tr>` +
      `<td class="qnum">${i + 1}</td>` +
      `<td>${questionBodyWord(q)}</td>` +
      `</tr></table>`;
  });
  return body;
}

function examSheetWord(d) {
  d = d || {};
  const rows = Array.isArray(d.rows) && d.rows.length ? d.rows : [{ q: "", mark: "" }];
  const teacherLabel = d.teacherLabel || "نام دبیر";
  const markLabel = d.markLabel || "بارم";
  const fontSize = parseInt(d.fontSize, 10) || 12;
  const tblStyle = "width:100%;table-layout:fixed;mso-table-layout-alt:fixed";
  const fontWrap = (inner) => `<div style="font-family:'B Nazanin',Tahoma,Arial;font-weight:bold;font-size:${fontSize}pt">${inner}</div>`;
  const examTitleFull = esc(d.examtitle || "آزمون نوبت اول") + (d.examtitleExtra ? " - " + esc(d.examtitleExtra) : "");
  let body =
    `<table class="meta-table" width="100%" style="${tblStyle}"><tr>` +
    `<td style="width:33%">نام و نام‌خانوادگی: ...................................</td>` +
    `<td style="width:34%;text-align:center">${esc(d.org1 || "وزارت آموزش و پرورش جمهوری اسلامی ایران")}</td>` +
    `<td style="width:33%">تاریخ آزمون: ${esc(d.date || "")}</td>` +
    `</tr><tr>` +
    `<td>نام پدر: ...................................</td>` +
    `<td style="text-align:center">${esc(d.org2 || "")}</td>` +
    `<td>زمان آزمون: ${esc(d.time || "")}</td>` +
    `</tr><tr>` +
    `<td>رشته / پایه: ${esc(d.grade || "")}</td>` +
    `<td>سال تحصیلی: ${esc(d.schoolyear || "")}</td>` +
    `<td>${examTitleFull}</td>` +
    `</tr></table>` +
    `<table class="meta-table" width="100%" style="${tblStyle};margin-top:6px"><tr>` +
    `<td style="width:50%">نام درس: ${esc(d.course || "")}</td>` +
    `<td style="width:50%">${esc(teacherLabel)}: ${esc(d.teacher || "")}</td>` +
    `</tr></table>` +
    `<table class="q" width="100%" style="${tblStyle};margin-top:6px">` +
    `<thead><tr><th class="qnum" style="width:8%">ردیف</th><th style="width:80%">سؤال</th><th style="width:12%">${esc(markLabel)}</th></tr></thead>` +
    `<tbody>` +
    rows.map((r, i) => {
      const sp = parseInt(r.space, 10) || 90;
      const brCount = r.q ? 0 : Math.max(1, Math.round(sp / 35));
      return `<tr style="height:${sp}px;mso-height-rule:atleast;page-break-inside:avoid"><td class="qnum" style="vertical-align:top">${toFaDigitsSrv(i + 1)}</td>` +
        `<td style="vertical-align:top;font-size:${fontSize}pt">${r.q || ""}${r.q ? "" : "<br>".repeat(brCount)}</td>` +
        `<td style="text-align:center;vertical-align:top">${esc(r.mark || "")}</td></tr>`;
    }).join("") +
    `</tbody></table>`;
  return fontWrap(body);
}

function answerLabel(q, ans) {
  if (q.type === "multiple") {
    const idx = Number(ans);
    if (!isNaN(idx) && q.options && q.options[idx] != null) {
      return `${["الف", "ب", "ج", "د"][idx] || idx + 1}) ${esc(q.options[idx])}`;
    }
    return esc(ans);
  }
  if (q.type === "truefalse") {
    if (ans === "true" || ans === true) return "صحیح";
    if (ans === "false" || ans === false) return "غلط";
    return esc(ans);
  }
  return esc(ans);
}

const MARK_LABEL = { correct: "صحیح", wrong: "غلط", partial: "نیمه‌درست" };

function answerSheetWord(sub) {
  const meta = sub.meta || DEFAULT_META;
  const questions = sub.questionsSnapshot || [];
  const g = sub.grading || {};
  const st = sub.student || {};
  let body = wordHeader(meta);
  body +=
    `<table class="meta-table">` +
    `<tr><td>نام و نام خانوادگی: ${esc(st.name)}</td><td>نام پدر: ${esc(st.fatherName)}</td><td>کد ملی: ${esc(st.nationalId)}</td></tr>` +
    `<tr><td>نام درس: ${esc(st.courseName)}</td><td>تاریخ ثبت: ${esc(new Date(sub.submittedAt).toLocaleString("fa-IR"))}</td><td></td></tr>` +
    `</table>`;

  body += `<table class="q"><tr><th class="qnum">ردیف</th><th>سوال</th><th>پاسخ دانش‌آموز</th><th>نمره</th><th>بازخورد معلم</th></tr>`;
  questions.forEach((q, i) => {
    const ans = sub.answers ? sub.answers[q.id] : "";
    const mark = g.marks ? g.marks[q.id] : "";
    const fb = g.feedback ? g.feedback[q.id] : "";
    let qcell = q.rich ? q.text : esc(q.text);
    if (q.image) qcell += `<div><img src="${esc(q.image)}" style="width:${q.imageWidth || 320}px;max-width:100%"></div>`;
    body +=
      `<tr><td class="qnum">${i + 1}</td>` +
      `<td>${qcell} <small>(${esc(QUESTION_TYPES[q.type] || q.type)})</small></td>` +
      `<td>${ans == null || ans === "" ? "<i>بدون پاسخ</i>" : answerLabel(q, ans)}</td>` +
      `<td>${esc(mark)}</td>` +
      `<td>${esc(fb || "")}</td></tr>`;
  });
  body += `</table>`;
  if (g.overall) body += `<p><b>نتیجه/بازخورد کلی:</b> ${esc(g.overall)}</p>`;
  return body;
}

/* ------------------------- استایل مشترک صفحات ------------------------- */

const SHARED_CSS = `
  :root{--bg:#f1f5f9;--card:#ffffff;--primary:#1d4ed8;--primary-2:#2563eb;--accent:#0d9488;--muted:#64748b;--line:#e2e8f0;--danger:#dc2626;--text:#0f172a;}
  [data-theme="light"]{--bg:#f1f5f9;--card:#ffffff;--primary:#1d4ed8;--primary-2:#2563eb;--muted:#64748b;--line:#e2e8f0;--text:#0f172a;}
  [data-theme="dark"]{--bg:#0f172a;--card:#1e293b;--primary:#3b82f6;--primary-2:#60a5fa;--muted:#94a3b8;--line:#334155;--text:#f1f5f9;}
  .theme-btn{padding:10px 20px;border:2px solid var(--line);border-radius:10px;background:var(--card);color:var(--text);font-size:14px;cursor:pointer;transition:all .2s}
  .theme-btn:hover{border-color:var(--primary);background:var(--primary);color:#fff}
  .theme-btn.active{border-color:var(--primary);background:var(--primary);color:#fff}
  *{box-sizing:border-box}
  body{margin:0;font-family:'Vazirmatn',Tahoma,system-ui,sans-serif;background:var(--bg);color:var(--text);direction:rtl;transition:background .3s,color .3s;}
  .wrap{max-width:960px;margin:0 auto;padding:18px;}
  .header{background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#fff;border-radius:18px;padding:22px;text-align:center;box-shadow:0 10px 30px rgba(37,99,235,.25);}
  [data-theme="dark"] body{background:linear-gradient(180deg,#0f172a,#1e293b);}
  [data-theme="light"] body{background:linear-gradient(180deg,#eef2ff,#f8fafc);}
  .header h1{margin:4px 0;font-size:22px}
  .header h2{margin:4px 0;font-size:15px;font-weight:500;opacity:.95}
  .header h3{margin:4px 0;font-size:13px;font-weight:400;opacity:.9}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin-top:16px;box-shadow:0 4px 16px rgba(15,23,42,.06)}
  label{display:block;font-size:14px;margin:10px 0 6px;font-weight:600}
  input,textarea,select{width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font-family:inherit;font-size:15px;background:#fff}
  input:focus,textarea:focus,select:focus{outline:none;border-color:var(--primary-2);box-shadow:0 0 0 3px rgba(37,99,235,.15)}
  textarea{min-height:90px;resize:vertical}
  .btn{display:inline-block;background:var(--primary);color:#fff;border:none;padding:11px 18px;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;text-decoration:none}
  .btn:hover{background:var(--primary-2)}
  .btn.sec{background:#0d9488}.btn.sec:hover{background:#0f766e}
  .btn.gray{background:#475569}.btn.gray:hover{background:#334155}
  .btn.gray.active{background:var(--primary);box-shadow:inset 0 0 0 2px rgba(255,255,255,.5)}
  .btn.danger{background:var(--danger)}
  .btn.sm{padding:6px 12px;font-size:13px}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  .row>*{flex:1;min-width:160px}
  .muted{color:var(--muted);font-size:13px}
  .q-block{border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:12px;background:#fbfdff}
  [data-theme="dark"] .q-block{background:#1e293b}
  .q-block .qhead{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
  .badge{background:#e0e7ff;color:#3730a3;border-radius:999px;padding:2px 10px;font-size:12px}
  [data-theme="dark"] .badge{background:#334155;color:#94a3b8}
  .opt-row{display:flex;gap:8px;align-items:center;margin-top:6px}
  .opt-row input[type=text]{flex:1}
  .toolbar{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0}
  .toolbar button{background:#eef2ff;border:1px solid #c7d2fe;border-radius:8px;padding:4px 9px;cursor:pointer;font-size:15px;min-width:32px}
  [data-theme="dark"] .toolbar button{background:#334155;border-color:#475569;color:#e2e8f0}
  .toolbar button:hover{background:#c7d2fe}
  .toolbar .grp-label{font-size:12px;color:var(--muted);align-self:center;margin-left:6px}
  .imgprev{height:auto;border:1px solid var(--line);border-radius:8px;margin-top:6px;display:block}
  table{width:100%;border-collapse:collapse;margin-top:10px}
  th,td{border:1px solid var(--line);padding:8px;text-align:right;font-size:14px;vertical-align:top}
  th{background:#f1f5f9}
  [data-theme="dark"] th{background:#334155}
  .tabs{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
  .tab{padding:9px 16px;border-radius:10px;background:#e2e8f0;cursor:pointer;font-weight:600;font-size:14px}
  [data-theme="dark"] .tab{background:#334155;color:#e2e8f0}
  .tab.active{background:var(--primary);color:#fff}
  .subtab{padding:8px 14px;border-radius:8px;background:#e2e8f0;cursor:pointer;font-weight:600;font-size:13px}
  [data-theme="dark"] .subtab{background:#334155;color:#e2e8f0}
  .subtab.active{background:var(--primary);color:#fff}
  .hidden{display:none}
  .toast{position:fixed;bottom:18px;right:18px;background:#0f172a;color:#fff;padding:12px 18px;border-radius:10px;opacity:0;transition:.3s;z-index:50}
  .toast.show{opacity:1}
  .link-box{font-family:monospace;direction:ltr;text-align:left;background:#f1f5f9;border-radius:8px;padding:8px;font-size:12px;word-break:break-all}
  [data-theme="dark"] .link-box{background:#1e293b}
  .pill{font-size:12px;padding:2px 8px;border-radius:999px}
  .pill.ok{background:#dcfce7;color:#166534}.pill.no{background:#fee2e2;color:#991b1b}.pill.gr{background:#dbeafe;color:#1e40af}
  
  /* ===== استایل‌های نتیجه آزمون ===== */
  .mark.correct{color:#166534;font-weight:700}
  .mark.wrong{color:#991b1b;font-weight:700}
  .mark.partial{color:#92400e;font-weight:700}
  .mark.excellent{color:#166534;font-weight:700}
  .mark.good{color:#2563eb;font-weight:700}
  .mark.acceptable{color:#d97706;font-weight:700}
  .mark.needs-improve{color:#dc2626;font-weight:700}
  .mark.numeric{color:#7c3aed;font-weight:700;font-size:16px}
  
  .result-card{background:linear-gradient(135deg,#f0f9ff,#e0f2fe);border:2px solid #93c5fd;border-radius:16px;padding:20px;margin-top:16px}
  [data-theme="dark"] .result-card{background:linear-gradient(135deg,#1e293b,#1e3a5f);border-color:#3b82f6}
  .result-card .total-score{font-size:22px;font-weight:700;color:#1e40af;text-align:center;padding:12px;background:#dbeafe;border-radius:12px;margin-bottom:16px}
  [data-theme="dark"] .result-card .total-score{background:#1e3a5f;color:#60a5fa}
  .result-table th{background:#3b82f6;color:#fff}
  .result-table .status-badge{display:inline-block;padding:4px 12px;border-radius:999px;font-size:13px;font-weight:600}
  .status-badge.correct{background:#dcfce7;color:#166534}
  .status-badge.wrong{background:#fee2e2;color:#991b1b}
  .status-badge.partial{background:#fef3c7;color:#92400e}
  .status-badge.excellent{background:#dcfce7;color:#166534}
  .status-badge.good{background:#dbeafe;color:#1e40af}
  .status-badge.acceptable{background:#fef3c7;color:#d97706}
  .status-badge.needs-improve{background:#fee2e2;color:#dc2626}
  
  .weight-input-box{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px 12px;margin-top:8px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .weight-input-box label{margin:0;font-size:13px;font-weight:600;color:#166534}
  .weight-input-box input{width:70px;padding:6px 8px;border:1px solid #bbf7d0;border-radius:6px;font-size:14px}
  .weight-input-box .weight-hint{font-size:12px;color:#64748b}
  .weight-total{background:#e0f2fe;border-radius:8px;padding:8px 16px;margin-top:8px;display:flex;justify-content:space-between;align-items:center;font-size:14px}
  .weight-total .total-value{font-weight:700;color:#1d4ed8;font-size:18px}
  .weight-total .total-value.valid{color:#166534}
  .weight-total .total-value.invalid{color:#dc2626}
  
  .rich{min-height:90px;border:1px solid #cbd5e1;border-radius:10px;padding:11px 12px;background:#fff;font-size:15px;line-height:1.9}
  [data-theme="dark"] .rich{background:#1e293b;border-color:#475569;color:#e2e8f0}
  .rich:focus{outline:none;border-color:var(--primary-2);box-shadow:0 0 0 3px rgba(37,99,235,.15)}
  .frac{display:inline-flex;flex-direction:column;text-align:center;vertical-align:middle;margin:0 3px;line-height:1.05}
  .frac .fn{display:block;border-bottom:2px solid currentColor;padding:0 5px}
  .frac .fd{display:block;padding:0 5px}
  .shape{display:inline-block;vertical-align:middle;line-height:1;margin:0 2px}
  .shape svg{display:block}
  .ldiv{display:inline-table;border-collapse:collapse;margin:6px 4px;vertical-align:middle}
  .ldiv td{padding:3px 10px;font-size:15px;text-align:center;vertical-align:top}
  .ldiv td.ld-bar{border-right:2px solid currentColor}
  .ldiv td.ld-top{border-bottom:2px solid currentColor;min-width:60px;min-height:20px}
  .ldiv .ld-divisor{vertical-align:bottom;padding-bottom:6px;font-weight:bold}
  .ldiv .ld-dividend{padding:2px 6px;text-align:center}
  .ldiv .ld-work{min-height:26px}

  /* ---- فرمول‌ساز ریاضی (شبیه MathType) ---- */
  .mt-modal-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:200;display:flex;align-items:center;justify-content:center;padding:16px}
  .mt-modal-overlay.hidden{display:none}
  .mt-modal{background:#fff;border-radius:16px;padding:18px;max-width:720px;width:100%;max-height:88vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)}
  [data-theme="dark"] .mt-modal{background:#1e293b;color:#e2e8f0}
  .mt-modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
  .mt-palette{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px}
  .mt-palette button{padding:6px 10px;border-radius:8px;border:1px solid #cbd5e1;background:#f8fafc;cursor:pointer;font-family:inherit;font-size:13px}
  [data-theme="dark"] .mt-palette button{background:#0f172a;border-color:#475569;color:#e2e8f0}
  .mt-canvas{min-height:80px;font-size:22px;direction:ltr;text-align:center}
  .mt-open-btn{font-weight:700}

  /* ---- دفتر مدیریت کلاسی ---- */
  .lb-menu-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-top:16px}
  .lb-menu-btn{display:flex;flex-direction:column;align-items:center;gap:6px;padding:22px 14px;border-radius:14px;border:1px solid var(--line);background:#f8fafc;cursor:pointer;font-family:inherit;text-align:center;transition:transform .15s,box-shadow .15s}
  .lb-menu-btn:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(0,0,0,.08);border-color:var(--primary)}
  [data-theme="dark"] .lb-menu-btn{background:#0f172a}
  .lb-menu-btn .lb-ico{font-size:32px}
  .lb-menu-btn .lb-t{font-weight:700;font-size:14px}
  .lb-menu-btn small{color:var(--muted);font-size:11px}
  .lb-panel{margin-top:8px}
  .lb-meta-form{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin:14px 0}
  .lb-meta-form label{display:block;font-size:12px;color:var(--muted);margin-bottom:3px}
  .lb-meta-form input{width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px;font-family:inherit}
  .lb-textarea{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-family:inherit;font-size:14px;resize:vertical;margin-bottom:12px}
  .lb-preview{overflow-x:auto;margin-top:10px;border:1px solid var(--line);border-radius:10px;padding:10px;background:#fff}
  [data-theme="dark"] .lb-preview{background:#1e293b}
  .lb-table{width:100%;border-collapse:collapse;font-size:12px}
  .lb-table th,.lb-table td{border:1px solid #94a3b8;padding:6px 8px;text-align:center}
  .lb-table th{background:#dbeafe;font-weight:700}
  [data-theme="dark"] .lb-table th{background:#1e3a5f}
  .lb-table input,.lb-table textarea{width:100%;border:none;background:transparent;text-align:center;font-family:inherit;font-size:12px;padding:2px}
  .lb-table-tight th,.lb-table-tight td{padding:3px 4px;font-size:11px}
  .lb-table-tight input{min-width:22px}
  .lb-diag-cell{position:relative;background:linear-gradient(to top left, transparent calc(50% - 1px), #94a3b8 calc(50% - 1px), #94a3b8 calc(50% + 1px), transparent calc(50% + 1px))!important;padding:0!important;height:44px;min-width:70px}
  .lb-diag-cell .lb-diag-top{position:absolute;top:2px;left:6px;font-size:10px;font-weight:700}
  .lb-diag-cell .lb-diag-bottom{position:absolute;bottom:2px;right:6px;font-size:10px;font-weight:700}
  .lb-table-zebra tbody tr:nth-child(odd){background:#f4f6f8}
  [data-theme="dark"] .lb-table-zebra tbody tr:nth-child(odd){background:#243247}
  .lb-pacing-table{width:max-content;min-width:100%;border-collapse:collapse;font-size:11px;margin-bottom:22px}
  .lb-pacing-table th,.lb-pacing-table td{border:1px solid #94a3b8;padding:4px 6px;text-align:center}
  .lb-pacing-table th{background:#dbeafe}
  [data-theme="dark"] .lb-pacing-table th{background:#1e3a5f}

  /* ---- آمار دانش‌آموزان به تفکیک جنسیت ---- */
  .lbg-sheet{max-width:720px;margin:18px auto 0;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px 24px;box-shadow:0 4px 18px rgba(0,0,0,.05)}
  [data-theme="dark"] .lbg-sheet{background:#0f172a;border-color:#334155}
  .lbg-title{text-align:center;font-size:17px;line-height:2.1;font-weight:700;margin:0 0 20px}
  .lbg-inline-input{display:inline-block;padding:4px 8px;border:none;border-bottom:2px solid var(--primary);background:transparent;font-family:inherit;font-weight:700;text-align:center;color:inherit;font-size:15px}
  .lbg-inline-input:focus{outline:none;background:rgba(102,126,234,.06)}
  .lbg-table{font-size:14px}
  .lbg-table th,.lbg-table td{padding:10px 12px;font-size:14px}
  .lbg-table th{background:#eef2ff}
  [data-theme="dark"] .lbg-table th{background:#1e2a4a}
  .lbg-table input{font-size:14px;font-weight:600;text-align:center}
  .lbg-sum{font-weight:700;background:#f8fafc}
  [data-theme="dark"] .lbg-sum{background:#1a2437}
  .lbg-total-row td{font-weight:800;background:#eef2ff;border-top:2px solid #94a3b8}
  [data-theme="dark"] .lbg-total-row td{background:#1e2a4a}
  .lbg-boxes{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-top:24px}
  .lbg-box{flex:1 1 180px;max-width:220px;background:#f8fafc;border:1px solid #dbe2ea;border-radius:12px;padding:16px 10px;text-align:center}
  [data-theme="dark"] .lbg-box{background:#1a2437;border-color:#334155}
  .lbg-box-main{background:#eef2ff;border-color:var(--primary)}
  [data-theme="dark"] .lbg-box-main{background:#1e2a4a}
  .lbg-box-label{display:block;font-size:12.5px;color:var(--muted);margin-bottom:8px;font-weight:600}
  .lbg-box-val{display:block;font-size:26px;font-weight:800;color:var(--primary)}
  .lb-pacing-table td.lb-subject{background:#f1f5f9;font-weight:700;white-space:nowrap;padding:4px 10px}
  [data-theme="dark"] .lb-pacing-table td.lb-subject{background:#0f172a}
  .lb-pacing-table td.lb-cell{min-width:100px;padding:2px}
  .lb-pacing-input{width:100%;min-height:56px;border:none;background:transparent;resize:vertical;font-family:inherit;font-size:11px;text-align:center;padding:3px;color:inherit}
  .lb-pacing-input:focus{outline:2px solid var(--primary);outline-offset:1px;background:#eef2ff;border-radius:6px}
  .lb-pacing-input::placeholder{color:#94a3b8;font-size:9px}
  .lb-nowruz{background:#16a34a !important;color:#fff;writing-mode:vertical-rl;text-orientation:mixed;font-weight:700;text-align:center}

  /* ---- پنل PDF کلاس آنلاین ---- */
  .cls-pdf-panel{background:#f8fafc;border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin-bottom:10px}
  [data-theme="dark"] .cls-pdf-panel{background:#0f172a}
  #cls-pdf-nav input[type="number"]{padding:4px;border:1px solid #cbd5e1;border-radius:6px}

  /* ---- چیدمان کلاس آنلاین: تخته بزرگ و در اولویت، به‌خصوص در گوشی ---- */
  .cls-board-col{flex:1 1 520px;min-width:280px}
  .cls-chat-col{flex:0 0 300px;min-width:260px}
  @media (max-width:760px){
    .cls-board-col{flex:1 1 100%}
    .cls-chat-col{flex:1 1 100%;min-width:0}
  }

  .mt-ph{display:inline-block;min-width:18px;min-height:1.1em;border:1px dashed #94a3b8;border-radius:4px;padding:0 3px;outline:none}
  .mt-ph:empty:before{content:attr(data-ph);color:#94a3b8;font-size:.7em}
  .mt-ph:focus{border-color:var(--primary-2);border-style:solid}

  .mt-frac{display:inline-flex;flex-direction:column;text-align:center;vertical-align:middle;margin:0 4px;line-height:1.1}
  .mt-frac .mt-num{display:block;border-bottom:2px solid currentColor;padding:0 4px}
  .mt-frac .mt-den{display:block;padding:0 4px}

  .mt-pow, .mt-sub{display:inline-block;vertical-align:middle;margin:0 3px}
  .mt-pow sup, .mt-sub sub{font-size:.68em}

  .mt-root{display:inline-flex;align-items:flex-start;vertical-align:middle;margin:0 4px}
  .mt-root .mt-idx{font-size:.6em;position:relative;top:.3em}
  .mt-root .mt-radsign{font-size:1.1em;padding:0 1px}
  .mt-root .mt-rad{text-decoration:overline;padding:0 3px}

  .mt-op{display:inline-flex;align-items:center;vertical-align:middle;margin:0 4px}
  .mt-op-stack{display:inline-flex;flex-direction:column;align-items:center;text-align:center;margin-left:4px}
  .mt-op-over,.mt-op-under{font-size:.55em;min-height:1em}
  .mt-op-sign{font-size:1.6em;line-height:1}

  .mt-lim{display:inline-flex;align-items:center;vertical-align:middle;margin:0 4px}
  .mt-lim-stack{display:inline-flex;flex-direction:column;align-items:center;text-align:center;margin-left:4px}
  .mt-lim-word{font-size:.7em}
  .mt-lim-under{font-size:.55em}

  .mt-matrix{display:inline-table;border-collapse:collapse;vertical-align:middle;margin:0 5px;border-left:2px solid currentColor;border-right:2px solid currentColor}
  .mt-matrix td{padding:4px 10px;text-align:center}

  .mt-paren{display:inline-flex;align-items:center;vertical-align:middle}
  .mt-paren-sign{font-size:1.4em}

  
  /* ---- اسکنر حرفه‌ای ---- */
  .upload-zone{border:2px dashed #cbd5e1;border-radius:16px;padding:40px 20px;text-align:center;cursor:pointer;transition:all .3s;background:#fafbfc;margin-bottom:16px}
  [data-theme="dark"] .upload-zone{background:#1e293b;border-color:#475569}
  .upload-zone:hover{border-color:var(--primary-2);background:#f0f4ff}
  .upload-zone.dragover{border-color:var(--primary);background:#eef2ff;transform:scale(1.02)}
  .upload-icon{font-size:48px;margin-bottom:12px}
  .filter-presets{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
  .filter-btn{padding:8px 16px;border:2px solid #e2e8f0;border-radius:10px;background:#fff;cursor:pointer;font-size:13px;font-weight:600;transition:all .2s}
  [data-theme="dark"] .filter-btn{background:#1e293b;border-color:#475569;color:#e2e8f0}
  .filter-btn:hover{border-color:var(--primary-2);background:#f0f4ff}
  .filter-btn.active{background:var(--primary);color:#fff;border-color:var(--primary)}
  .scan-settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:16px}
  .setting-group{background:#f8fafc;border-radius:12px;padding:14px;border:1px solid #e2e8f0}
  [data-theme="dark"] .setting-group{background:#1e293b;border-color:#475569}
  .setting-group label{display:block;font-weight:600;margin-bottom:8px;font-size:13px;color:#475569}
  [data-theme="dark"] .setting-group label{color:#94a3b8}
  .setting-group input[type=range]{width:100%;height:6px;-webkit-appearance:none;background:#e2e8f0;border-radius:3px;outline:none}
  .setting-group input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;background:var(--primary);border-radius:50%;cursor:pointer;box-shadow:0 2px 6px rgba(37,99,235,.3)}
  .setting-value{float:left;font-weight:700;color:var(--primary-2);font-size:14px;margin-top:4px}
  .scan-preview{background:#f1f5f9;border-radius:16px;padding:16px;text-align:center;overflow:auto;max-height:500px;border:1px solid #e2e8f0;margin-bottom:16px}
  [data-theme="dark"] .scan-preview{background:#1e293b;border-color:#475569}
  .scan-preview canvas{max-width:100%;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.1)}
  .scan-toolbar{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  .pdf-toolbar{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:10px}
  .pdf-toolbar .btn{flex:0 0 auto}
  .org-field-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
  .org-field{display:flex;flex-direction:column;gap:4px}
  .org-field label{font-size:12.5px;font-weight:700;color:var(--muted)}
  .org-field input,.org-field select{padding:8px 10px;border:1px solid #ddd;border-radius:8px;font-family:inherit;background:#fffdf5}
  [data-theme="dark"] .org-field input,[data-theme="dark"] .org-field select{background:#1a2437;border-color:#334155;color:#f1f5f9}
  #org-stat-table input,#org-staff-table input,#org-staff-table select,#org-hours-table input{width:100%;box-sizing:border-box;padding:5px 4px;border:1px solid #e2e8f0;border-radius:4px;text-align:center;font-family:inherit}
  #org-stat-table td,#org-staff-table td,#org-hours-table td{white-space:nowrap}

  /* ---- چاپ فرم سازمان عملی: خط‌کشی مشکی و مقیاس مناسب کاغذ ---- */
  @media print{
    body *{visibility:hidden}
    #tab-orgform, #tab-orgform *{visibility:visible}
    #tab-orgform{position:absolute;top:0;right:0;left:0;width:100%}
    .top-nav, .tabs, .subtabs, .row button, #btn-org-save, #btn-org-form, #btn-org-staff-addrow, #btn-org-hours-addrow, .org-row-del-cell{display:none!important}
    @page{size:landscape;margin:8mm}
    #org-stat-table, #org-staff-table, #org-hours-table, #org-special-table{font-size:9px;border-collapse:collapse!important}
    #org-stat-table th, #org-stat-table td, #org-staff-table th, #org-staff-table td, #org-hours-table th, #org-hours-table td, #org-special-table td{border:1px solid #000!important;padding:2px 3px!important}
    .xls-scroll{overflow:visible!important}
    #org-stat-table input,#org-staff-table input,#org-hours-table input,#org-special-table input{border:none!important;font-size:9px!important;padding:0!important}
  }
  
  /* ---- کاهش حجم ---- */
  .resize-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;margin-bottom:16px}
  .resize-group{background:#f8fafc;border-radius:12px;padding:16px;border:1px solid #e2e8f0}
  [data-theme="dark"] .resize-group{background:#1e293b;border-color:#475569}
  .resize-group label{display:block;font-weight:600;margin-bottom:10px;font-size:14px;color:#334155}
  [data-theme="dark"] .resize-group label{color:#94a3b8}
  .size-inputs{display:flex;gap:12px;margin-bottom:10px}
  .input-with-label{display:flex;align-items:center;gap:6px}
  .input-with-label input{width:100px;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px}
  .input-with-label input:focus{border-color:var(--primary-2);outline:none}
  .checkbox-label{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:normal}
  .quality-display{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
  #quality-percent{font-weight:700;color:var(--primary-2);font-size:18px}
  .format-options{display:flex;gap:8px}
  .format-btn{padding:8px 20px;border:2px solid #e2e8f0;border-radius:8px;background:#fff;cursor:pointer;font-weight:600;font-size:13px;transition:all .2s}
  [data-theme="dark"] .format-btn{background:#1e293b;color:#e2e8f0}
  .format-btn:hover{border-color:var(--primary-2)}
  .format-btn.active{background:var(--primary);color:#fff;border-color:var(--primary)}
  .size-options{display:flex;flex-wrap:wrap;gap:12px}
  .size-option{display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px}
  .size-option input[type=radio]{width:auto;cursor:pointer}
  .resize-preview{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:16px}
  .resize-item{position:relative;background:#f8fafc;border-radius:12px;padding:8px;border:1px solid #e2e8f0;text-align:center}
  [data-theme="dark"] .resize-item{background:#1e293b}
  .resize-item img{max-width:100%;max-height:120px;border-radius:8px}
  .resize-item .size-info{font-size:11px;color:#64748b;margin-top:6px}
  .resize-item .remove-btn{position:absolute;top:4px;left:4px;background:#fee2e2;color:#991b1b;border:none;border-radius:50%;width:24px;height:24px;cursor:pointer;font-size:14px}
  .resize-toolbar{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  
  /* ===== Crop - با پشتیبانی از لمس برای گوشی ===== */
  .crop-area{background:#1e293b;border-radius:12px;padding:16px;margin:16px 0;display:flex;justify-content:center;overflow:hidden}
  #crop-wrapper{position:relative;display:inline-block;max-width:100%}
  #crop-img{display:block}
  #crop-box{position:absolute;border:2px dashed #fff;box-shadow:0 0 0 9999px rgba(0,0,0,.5);cursor:move;top:0;left:0}
  
  /* دسته‌های برش - بزرگ برای گوشی */
  .crop-handle{
    position:absolute;
    width:20px;
    height:20px;
    background:#fff;
    border:2.5px solid #1e293b;
    border-radius:50%;
    z-index:10;
    touch-action:none;
    box-shadow:0 2px 8px rgba(0,0,0,0.3);
  }
  .crop-handle:active{transform:scale(1.2);background:#e0f2fe}
  .crop-nw{top:-8px;left:-8px;cursor:nw-resize}
  .crop-n{top:-8px;left:50%;transform:translateX(-50%);cursor:n-resize}
  .crop-ne{top:-8px;right:-8px;cursor:ne-resize}
  .crop-w{top:50%;left:-8px;transform:translateY(-50%);cursor:w-resize}
  .crop-e{top:50%;right:-8px;transform:translateY(-50%);cursor:e-resize}
  .crop-sw{bottom:-8px;left:-8px;cursor:sw-resize}
  .crop-s{bottom:-8px;left:50%;transform:translateX(-50%);cursor:s-resize}
  .crop-se{bottom:-8px;right:-8px;cursor:se-resize}
  
  /* بزرگتر برای گوشی‌های کوچک */
  @media (max-width:600px){
    .crop-handle{width:28px;height:28px;border-width:3px}
    .crop-nw{top:-12px;left:-12px}
    .crop-n{top:-12px;left:50%;transform:translateX(-50%)}
    .crop-ne{top:-12px;right:-12px}
    .crop-w{top:50%;left:-12px;transform:translateY(-50%)}
    .crop-e{top:50%;right:-12px;transform:translateY(-50%)}
    .crop-sw{bottom:-12px;left:-12px}
    .crop-s{bottom:-12px;left:50%;transform:translateX(-50%)}
    .crop-se{bottom:-12px;right:-12px}
  }
  
  .crop-options{margin-bottom:12px}
  .crop-ratios{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .crop-ratios span{font-weight:600;font-size:14px}
  .ratio-btn{padding:6px 14px;border:2px solid #e2e8f0;border-radius:6px;background:#fff;cursor:pointer;font-size:13px}
  .ratio-btn:hover{border-color:var(--primary-2)}
  .ratio-btn.active{background:var(--primary);color:#fff;border-color:var(--primary)}
  .crop-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  
  /* ---- برنامه هفتگی (نسخه‌ی پیشرفته: نوار رنگی کنار هر روز، تایپوگرافی بهتر، هایلایت امروز) ---- */
  .schedule-table-wrap{overflow-x:auto;border-radius:18px;background:#fff;margin-bottom:16px;box-shadow:0 10px 30px rgba(15,23,42,.10),0 2px 8px rgba(15,23,42,.06);border:2px solid #000}
  [data-theme="dark"] .schedule-table-wrap{background:#1e293b;border-color:#000;box-shadow:0 10px 30px rgba(0,0,0,.35)}
  .schedule-table{width:100%;border-collapse:separate;border-spacing:0}
  .schedule-table th{padding:16px 10px;font-weight:800;text-align:center;font-size:14px;letter-spacing:.2px;border-bottom:2px solid #000}
  [data-theme="dark"] .schedule-table th{border-color:#000}
  .schedule-table th.sch-corner{background:linear-gradient(135deg,#1e293b,#334155);color:#fff;border-radius:18px 0 0 0}
  [data-theme="dark"] .schedule-table th.sch-corner{background:linear-gradient(135deg,#0f172a,#1e293b)}
  .schedule-table th.sch-period{background:#f1f5f9;color:#334155;border-left:2px solid #000}
  [data-theme="dark"] .schedule-table th.sch-period{background:#0f172a;color:#e2e8f0;border-color:#000}
  .schedule-table th.sch-period:last-child{border-radius:0 18px 0 0;border-left:none}
  .schedule-table td{padding:12px 8px;text-align:center;font-weight:600;color:#1e293b;border-bottom:2px solid #000;border-left:2px solid #000}
  [data-theme="dark"] .schedule-table td{color:#f1f5f9;border-color:#000}
  .schedule-table tr:last-child td{border-bottom:none}
  .schedule-table tr:last-child td:first-child{border-radius:0 0 0 18px}
  .schedule-table tr:last-child td:last-child{border-radius:0 0 18px 0}
  .schedule-table td:first-child{font-weight:800;text-align:center;font-size:14px;border-left:none;position:relative;padding-right:16px}
  .sch-day-accent{position:absolute;top:8px;bottom:8px;right:2px;width:4px;border-radius:4px}
  .schedule-table td.sch-daylabel-shanbe .sch-day-accent{background:#ef4444}
  .schedule-table td.sch-daylabel-yekshanbe .sch-day-accent{background:#f59e0b}
  .schedule-table td.sch-daylabel-doshshanbe .sch-day-accent{background:#10b981}
  .schedule-table td.sch-daylabel-seshshanbe .sch-day-accent{background:#8b5cf6}
  .schedule-table td.sch-daylabel-chaharshanbe .sch-day-accent{background:#06b6d4}
  .schedule-table td.cell-shanbe{background:#fef2f2}
  .schedule-table td.cell-yekshanbe{background:#fffbeb}
  .schedule-table td.cell-doshshanbe{background:#f0fdf4}
  .schedule-table td.cell-seshshanbe{background:#f5f3ff}
  .schedule-table td.cell-chaharshanbe{background:#ecfeff}
  [data-theme="dark"] .schedule-table td.sch-daylabel-shanbe,[data-theme="dark"] .schedule-table td.cell-shanbe{background:#2a1e1e}
  [data-theme="dark"] .schedule-table td.sch-daylabel-yekshanbe,[data-theme="dark"] .schedule-table td.cell-yekshanbe{background:#2a2618}
  [data-theme="dark"] .schedule-table td.sch-daylabel-doshshanbe,[data-theme="dark"] .schedule-table td.cell-doshshanbe{background:#18291f}
  [data-theme="dark"] .schedule-table td.sch-daylabel-seshshanbe,[data-theme="dark"] .schedule-table td.cell-seshshanbe{background:#241f33}
  [data-theme="dark"] .schedule-table td.sch-daylabel-chaharshanbe,[data-theme="dark"] .schedule-table td.cell-chaharshanbe{background:#17282a}

  /* ---- سوییچ تم برنامهٔ هفتگی ---- */
  .sch-theme-btn{opacity:.6;transition:opacity .15s,transform .15s}
  .sch-theme-btn.active{opacity:1;transform:scale(1.05);box-shadow:0 2px 8px rgba(0,0,0,.15)}

  /* تم پسرانه: آبی/فیروزه‌ای */
  #schedule-table-wrap.theme-boy .schedule-table th.sch-corner{background:linear-gradient(135deg,#1e3a8a,#2563eb)}
  #schedule-table-wrap.theme-boy .schedule-table th.sch-period{background:#eff6ff;color:#1e3a8a}
  [data-theme="dark"] #schedule-table-wrap.theme-boy .schedule-table th.sch-period{background:#0f1f3d;color:#bfdbfe}
  #schedule-table-wrap.theme-boy .sch-day-accent{background:#2563eb!important}
  #schedule-table-wrap.theme-boy td.cell-shanbe{background:#dbeafe}
  #schedule-table-wrap.theme-boy td.cell-yekshanbe{background:#e0f2fe}
  #schedule-table-wrap.theme-boy td.cell-doshshanbe{background:#cffafe}
  #schedule-table-wrap.theme-boy td.cell-seshshanbe{background:#e0e7ff}
  #schedule-table-wrap.theme-boy td.cell-chaharshanbe{background:#dbeafe}
  [data-theme="dark"] #schedule-table-wrap.theme-boy td.cell-shanbe,[data-theme="dark"] #schedule-table-wrap.theme-boy td.cell-yekshanbe,[data-theme="dark"] #schedule-table-wrap.theme-boy td.cell-doshshanbe,[data-theme="dark"] #schedule-table-wrap.theme-boy td.cell-seshshanbe,[data-theme="dark"] #schedule-table-wrap.theme-boy td.cell-chaharshanbe{background:#132743}

  /* تم دخترانه: صورتی/بنفش */
  #schedule-table-wrap.theme-girl .schedule-table th.sch-corner{background:linear-gradient(135deg,#9d174d,#db2777)}
  #schedule-table-wrap.theme-girl .schedule-table th.sch-period{background:#fdf2f8;color:#9d174d}
  [data-theme="dark"] #schedule-table-wrap.theme-girl .schedule-table th.sch-period{background:#3d0f27;color:#fbcfe8}
  #schedule-table-wrap.theme-girl .sch-day-accent{background:#db2777!important}
  #schedule-table-wrap.theme-girl td.cell-shanbe{background:#fce7f3}
  #schedule-table-wrap.theme-girl td.cell-yekshanbe{background:#fdf2f8}
  #schedule-table-wrap.theme-girl td.cell-doshshanbe{background:#fae8ff}
  #schedule-table-wrap.theme-girl td.cell-seshshanbe{background:#f3e8ff}
  #schedule-table-wrap.theme-girl td.cell-chaharshanbe{background:#ffe4e6}
  [data-theme="dark"] #schedule-table-wrap.theme-girl td.cell-shanbe,[data-theme="dark"] #schedule-table-wrap.theme-girl td.cell-yekshanbe,[data-theme="dark"] #schedule-table-wrap.theme-girl td.cell-doshshanbe,[data-theme="dark"] #schedule-table-wrap.theme-girl td.cell-seshshanbe,[data-theme="dark"] #schedule-table-wrap.theme-girl td.cell-chaharshanbe{background:#3d1730}
  .schedule-table tr.sch-today td{box-shadow:inset 0 0 0 2px var(--primary)}
  .schedule-table tr.sch-today td:first-child .sch-today-badge{position:absolute;top:2px;left:6px;font-size:9px;background:var(--primary);color:#fff;padding:1px 7px;border-radius:8px;font-weight:700}
  .schedule-table textarea{background:transparent;border:none;width:100%;min-height:50px;text-align:center;font-family:inherit;font-size:13px;color:inherit;resize:vertical;line-height:1.5}
  .schedule-table textarea:focus{outline:2px solid var(--primary);outline-offset:2px;border-radius:8px}
  .schedule-table textarea::placeholder{color:#94a3b8;font-style:italic}
  
  /* ---- ترجمه ---- */
  .tl-lang-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px}
  .tl-lang-row select{padding:9px 10px;border:1px solid #ddd;border-radius:8px;font-family:inherit;font-size:14px;background:#fff}
  [data-theme="dark"] .tl-lang-row select{background:#1e293b;border-color:#475569;color:#e2e8f0}
  .tl-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .tl-grid textarea{width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;resize:vertical;font-family:inherit;font-size:14px}
  [data-theme="dark"] .tl-grid textarea{background:#1e293b;border-color:#475569;color:#e2e8f0}
  .tl-grid textarea[readonly]{background:#f8fafc}
  [data-theme="dark"] .tl-grid textarea[readonly]{background:#0f172a}
  @media (max-width:640px){ .tl-grid{grid-template-columns:1fr} }

  /* ---- جدول‌ساز: شبیه اکسل واقعی ---- */
  .xls-wrap{border:1px solid #b7b7b7;border-radius:8px;overflow:hidden;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.06)}
  [data-theme="dark"] .xls-wrap{background:#1e293b;border-color:#475569}
  .xls-scroll{overflow:auto;max-height:520px}
  .xls-grid{border-collapse:collapse;width:100%;font-family:'Vazirmatn',Tahoma,sans-serif;font-size:13px}
  .xls-grid th, .xls-grid td{border:1px solid #d4d4d4;padding:0;height:32px;min-width:90px}
  [data-theme="dark"] .xls-grid th, [data-theme="dark"] .xls-grid td{border-color:#3f4b5c}
  .xls-colhead{background:#f3f3f3;color:#616161;text-align:center;font-weight:600;font-size:12px;position:sticky;top:0;z-index:3;user-select:none}
  [data-theme="dark"] .xls-colhead{background:#0f172a;color:#94a3b8}
  .xls-corner{background:#f3f3f3;position:sticky;right:0;top:0;z-index:4}
  [data-theme="dark"] .xls-corner{background:#0f172a}
  .xls-rowhead{background:#f3f3f3;color:#616161;text-align:center;font-weight:600;font-size:12px;position:sticky;right:0;z-index:2;min-width:36px;width:36px}
  [data-theme="dark"] .xls-rowhead{background:#0f172a;color:#94a3b8}
  .xls-titlerow th{background:#e8eaf6;padding:0}
  [data-theme="dark"] .xls-titlerow th{background:#312e50}
  .xls-titlerow input{width:100%;height:34px;border:none;background:transparent;text-align:center;font-weight:700;color:#1e293b;padding:0 6px;font-family:inherit;font-size:13px}
  [data-theme="dark"] .xls-titlerow input{color:#e2e8f0}
  .xls-titlerow input:focus{outline:2px solid var(--primary);outline-offset:-2px;background:#fff}
  .xls-grid td input{width:100%;height:32px;border:none;background:transparent;text-align:center;padding:0 6px;font-family:inherit;font-size:13px;color:#1e293b}
  [data-theme="dark"] .xls-grid td input{color:#e2e8f0}
  .xls-grid td input:focus{outline:2px solid var(--primary);outline-offset:-2px;background:#eef2ff;position:relative;z-index:1}
  .xls-grid tbody tr:nth-child(even) td{background:#fafbfc}
  [data-theme="dark"] .xls-grid tbody tr:nth-child(even) td{background:#243044}
  .xls-avgrow td{background:#e2efda !important;font-weight:700;color:#375623;text-align:center}
  [data-theme="dark"] .xls-avgrow td{background:#22381f !important;color:#c8e6c9}
  .xls-avgrow td:first-child{text-align:center}
  
  .ai-chat-container{background:#fff;border-radius:16px;border:1px solid #e5e7eb;overflow:hidden;display:flex;flex-direction:column;height:min(650px,80vh)}
  [data-theme="dark"] .ai-chat-container{background:#171717;border-color:#333}
  .ai-header{display:flex;align-items:center;gap:10px;padding:12px 16px;background:#fff;border-bottom:1px solid #e5e7eb;color:#1f2937}
  [data-theme="dark"] .ai-header{background:#171717;border-color:#333;color:#e5e5e5}
  .ai-avatar{width:32px;height:32px;background:#da7756;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
  .ai-title{flex:1;min-width:0}
  .ai-title h3{margin:0;font-size:15px;font-weight:700}
  .ai-status{font-size:11px;opacity:.6}
  .ai-mode-select select{padding:8px 12px;border-radius:8px;border:1px solid #e5e7eb;background:#fff;color:#333;font-size:13px;font-weight:600;cursor:pointer}
  .ai-messages{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:14px 12px;display:flex;flex-direction:column;gap:16px;background:#fff}
  [data-theme="dark"] .ai-messages{background:#171717}
  .ai-message{display:flex;gap:8px;max-width:92%}
  .ai-message.user{flex-direction:row-reverse;align-self:flex-end;max-width:88%}
  .ai-message.ai{align-self:flex-start;max-width:100%;width:100%}
  .ai-message-avatar{width:26px;height:26px;background:#e0e7ff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
  .ai-message.user .ai-message-avatar{display:none}
  .ai-message.ai .ai-message-avatar{background:#da7756;font-size:13px}
  .ai-message-content{background:transparent;border-radius:0;padding:0;box-shadow:none;border:none;min-width:0;flex:1}
  [data-theme="dark"] .ai-message-content{color:#e5e5e5}
  .ai-message.user .ai-message-content{background:#f0efec;color:#1f2937;border-radius:18px;padding:9px 14px;flex:0 1 auto}
  [data-theme="dark"] .ai-message.user .ai-message-content{background:#2a2a2a;color:#e5e5e5}
  .ai-message-text{line-height:1.6;font-size:14.5px;white-space:pre-wrap;user-select:text;word-break:break-word}
  .ai-copy-btn{display:inline-flex;align-items:center;gap:4px;margin-top:6px;padding:3px 9px;font-size:11px;font-weight:600;border-radius:999px;border:1px solid #e5e7eb;background:#fff;color:#6b7280;cursor:pointer;transition:all .15s}
  [data-theme="dark"] .ai-copy-btn{background:#262626;border-color:#404040;color:#a3a3a3}
  .ai-copy-btn:hover{background:#da7756;color:#fff;border-color:#da7756}
  .ai-del-btn{display:inline-flex;align-items:center;gap:4px;margin-top:6px;margin-inline-start:6px;padding:3px 9px;font-size:11px;font-weight:600;border-radius:999px;border:1px solid #fecaca;background:#fff;color:#dc2626;cursor:pointer;transition:all .15s}
  [data-theme="dark"] .ai-del-btn{background:#262626}
  .ai-del-btn:hover{background:#dc2626;color:#fff;border-color:#dc2626}
  .ai-typing-dots{display:flex;gap:4px;padding:8px 0}
  .ai-typing-dots span{width:7px;height:7px;background:#da7756;border-radius:50%;animation:typingBounce 1.4s infinite ease-in-out}
  .ai-typing-dots span:nth-child(1){animation-delay:-.32s}
  .ai-typing-dots span:nth-child(2){animation-delay:-.16s}
  @keyframes typingBounce{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}
  .ai-input-area{display:flex;gap:8px;padding:10px 12px;padding-bottom:max(10px,env(safe-area-inset-bottom));border-top:1px solid #e5e7eb;background:#fff;align-items:flex-end}
  [data-theme="dark"] .ai-input-area{background:#171717;border-color:#333}
  .ai-input-area textarea{flex:1;padding:11px 14px;border:1px solid #e5e7eb;border-radius:20px;resize:none;font-size:16px;line-height:1.4;max-height:120px;font-family:inherit;background:#fff}
  [data-theme="dark"] .ai-input-area textarea{background:#262626;border-color:#404040;color:#e5e5e5}
  .ai-input-area textarea:focus{border-color:#da7756;outline:none}
  .ai-send-btn{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:17px;padding:0;flex-shrink:0}
  .ai-attach-preview{display:flex;align-items:center;gap:10px;padding:8px 14px;background:#f8fafc;border-top:1px solid #e5e7eb;animation:clsDrawerOpen .15s ease-out}
  [data-theme="dark"] .ai-attach-preview{background:#262626;border-color:#404040}
  .ai-attach-preview span{font-size:12.5px;color:#475569;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  [data-theme="dark"] .ai-attach-preview span{color:#d4d4d4}
  .ai-attach-remove{flex:0 0 auto;width:26px;height:26px;border-radius:50%;border:1px solid #e5e7eb;background:#fff;color:#dc2626;font-size:13px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s}
  [data-theme="dark"] .ai-attach-remove{background:#171717;border-color:#404040}
  .ai-attach-remove:hover{background:#dc2626;color:#fff;border-color:#dc2626}
  @media(max-width:640px){
    .ai-chat-container{height:calc(100vh - 220px);min-height:420px;border-radius:12px}
    .ai-header{padding:10px 12px}
    .ai-avatar{width:28px;height:28px;font-size:14px}
    .ai-title h3{font-size:14px}
    .ai-messages{padding:10px 8px;gap:14px}
    .ai-message.user{max-width:94%}
    .ai-input-area{padding:8px}
    .ai-input-area textarea{padding:10px 12px}
  }
  
  .cls-options-drawer{display:flex;flex-direction:column;gap:8px;padding:10px;margin-bottom:12px;background:#f8fafc;border:1px solid var(--line);border-radius:12px;animation:clsDrawerOpen .18s ease-out}
  [data-theme="dark"] .cls-options-drawer{background:#1e293b}
  @keyframes clsDrawerOpen{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
  .cls-opt-btn{width:100%;justify-content:flex-start;text-align:right;padding:11px 14px;font-size:14px}
  @media(max-width:640px){
    .cls-wrap{flex-direction:column}
    #t-cam-preview{max-width:100%;width:100%}
  }

  /* ---- ساخت آزمون (برگه چاپی) ---- */
  #es-print-area{background:#fff;padding:16px;border:1px solid var(--line);border-radius:12px;font-family:'B Nazanin','Tahoma',sans-serif;font-weight:bold}
  [data-theme="dark"] #es-print-area{background:#1e293b}
  .es-header-table{width:100%;border-collapse:collapse;table-layout:fixed}
  .es-header-table td{border:1px solid #000;padding:6px 8px;vertical-align:top}
  .es-header-table input{border:none;background:transparent;width:100%;font-family:inherit;font-weight:bold;font-size:14px;padding:2px 0;color:inherit}
  .es-header-table input:focus{outline:none;background:#fffbe6}
  [data-theme="dark"] .es-header-table input:focus{background:#334155}
  .es-header-table td span{font-size:13.5px;font-weight:bold;display:inline-block;margin-left:4px}
  .es-header-table select,.es-main-table select{border:none;background:transparent;font-family:inherit;font-size:13.5px;font-weight:bold;color:inherit;cursor:pointer}
  .es-header-table select:focus,.es-main-table select:focus{outline:none}
  .es-hdr-org input{text-align:center;font-weight:bold}
  .es-blank{border-bottom:1px dotted #000!important}
  #es-print-area{--es-font-size:12pt}
  .es-main-table{width:100%;border-collapse:collapse;margin-top:6px}
  .es-main-table th,.es-main-table td{border:1px solid #000;padding:8px;vertical-align:top;font-size:var(--es-font-size,12pt)}
  .es-main-table thead th{background:#f1f5f9;font-weight:bold;text-align:center}
  [data-theme="dark"] .es-main-table thead th{background:#334155}
  .es-col-num{width:44px;text-align:center;font-weight:bold}
  .es-col-mark{width:80px;text-align:center}
  .es-q-cell{position:relative}
  .es-q{width:100%;min-height:90px;font-family:inherit;font-weight:bold;font-size:var(--es-font-size,12pt);outline:none;white-space:pre-wrap;word-break:break-word}
  .es-q:focus{background:#fffbe6}
  [data-theme="dark"] .es-q:focus{background:#334155}
  .es-q table{border-collapse:collapse;margin:6px 0}
  .es-q table td{border:1px solid #000;padding:8px;min-width:36px;font-size:inherit}
  .es-q-tools{display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-top:6px}
  .es-q-tools button{background:none;border:1px solid #e2e8f0;border-radius:6px;color:#475569;cursor:pointer;font-size:11px;padding:2px 7px}
  [data-theme="dark"] .es-q-tools button{border-color:#404040;color:#a3a3a3}
  .es-space-ctrl{display:inline-flex;align-items:center;gap:4px;margin-inline-start:6px;font-size:11px;color:#475569}
  [data-theme="dark"] .es-space-ctrl{color:#a3a3a3}
  .es-space-btn{background:none;border:1px solid #e2e8f0;border-radius:6px;color:#475569;cursor:pointer;font-size:11px;padding:2px 7px;line-height:1}
  [data-theme="dark"] .es-space-btn{border-color:#404040;color:#a3a3a3}
  .es-space-val{min-width:24px;text-align:center;display:inline-block;font-weight:bold}
  .es-main-table input.es-mark{width:100%;border:none;text-align:center;font-family:inherit;font-weight:bold;font-size:var(--es-font-size,12pt);background:transparent;color:inherit}
  .es-row-del{width:100%;background:none;border:none;color:#dc2626;cursor:pointer;font-size:15px}
  .es-pagefoot{text-align:center;font-weight:bold;margin-top:8px;font-size:14px}
  .es-tbl-wrap{display:inline-block;max-width:100%;width:70%;margin:6px 0;border:1px dashed #cbd5e1;border-radius:8px;padding:6px;vertical-align:top;box-sizing:border-box}
  [data-theme="dark"] .es-tbl-wrap{border-color:#404040}
  .es-tbl-toolbar{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:5px}
  .es-tbl-toolbar button{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:5px;color:#334155;cursor:pointer;font-size:10.5px;padding:3px 6px;white-space:nowrap}
  .es-tbl-toolbar .es-tbl-del{background:#fee2e2;color:#dc2626;border-color:#fecaca}
  [data-theme="dark"] .es-tbl-toolbar button{background:#262626;border-color:#404040;color:#a3a3a3}
  [data-theme="dark"] .es-tbl-toolbar .es-tbl-del{background:#450a0a;color:#fca5a5;border-color:#7f1d1d}
  .es-tbl-wrap table{width:100%;border-collapse:collapse;margin:0}
  .es-tbl-wrap table td{border:1px solid #000;padding:8px;min-width:24px;font-size:inherit}
  @media print{
    body *{visibility:hidden}
    #es-print-area, #es-print-area *{visibility:visible}
    #es-print-area{position:absolute;top:0;right:0;left:0;width:100%;padding:0;border:none;border-radius:0;margin:0}
    .es-main-table tr{page-break-inside:avoid}
    .es-q,.es-main-table input.es-mark,.es-header-table input,.es-header-table select,.es-main-table select{color:#000!important}
    .es-q-tools{display:none!important}
    .es-tbl-wrap{border:none!important;padding:0!important}
    .es-tbl-toolbar{display:none!important}
  }

  /* ---- Timer ---- */
  .exam-timer{background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;border-radius:16px;padding:20px;text-align:center;margin-bottom:16px;border:2px solid #0f3460}
  .exam-timer .timer-display{font-size:48px;font-weight:700;font-family:monospace;letter-spacing:4px;color:#00d2ff;text-shadow:0 0 20px rgba(0,210,255,0.3)}
  .exam-timer .timer-label{font-size:14px;color:#94a3b8;margin-top:4px}
  .exam-timer.warning .timer-display{color:#f59e0b;text-shadow:0 0 20px rgba(245,158,11,0.3)}
  .exam-timer.danger .timer-display{color:#ef4444;text-shadow:0 0 20px rgba(239,68,68,0.3);animation:blink 1s ease-in-out infinite}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}
  
  /* ---- Exam Time Status ---- */
  .exam-time-status{padding:12px 16px;border-radius:10px;margin-bottom:16px;font-weight:600;display:flex;align-items:center;gap:10px}
  .exam-time-status.valid{background:#dcfce7;color:#166534;border:1px solid #bbf7d0}
  .exam-time-status.invalid{background:#fee2e2;color:#991b1b;border:1px solid #fecaca}
  .exam-time-status.waiting{background:#fef3c7;color:#92400e;border:1px solid #fde68a}
  .exam-time-status .time-icon{font-size:24px}
`;

const FONT_LINK = `<link rel="preconnect" href="https://cdn.jsdelivr.net"><link href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css" rel="stylesheet">`;

function pageHeader() {
  return `<div class="header"><h1>${esc(APP_TITLE)}</h1><h2>${esc(APP_DESIGNER)}</h2></div>`;
}

/* ------------------------- صفحه اصلی ------------------------- */

function landingPage() {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(APP_TITLE)}</title>
  ${FONT_LINK}<style>${SHARED_CSS}</style></head><body><div class="wrap">
  ${pageHeader()}
  <div class="card">
    <p>دانش‌آموز گرامی، برای شرکت در آزمون از <b>لینک اختصاصی</b> که معلم برای شما ارسال کرده استفاده کنید.</p>
    <p class="muted">هر دانش‌آموز یک لینک منحصربه‌فرد دارد.</p>
    <hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
    <a class="btn" href="/teacher">ورود معلم</a>
  </div></div></body></html>`;
}

function notFoundPage() {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  ${FONT_LINK}<style>${SHARED_CSS}</style></head><body><div class="wrap">
  ${pageHeader()}<div class="card"><h2>صفحه یافت نشد</h2><a class="btn" href="/">بازگشت</a></div></div></body></html>`;
}

/* ------------------------- صفحه دانش‌آموز ------------------------- */

async function studentPage(env, id) {
  const student = await env.EXAM_KV.get("student:" + id);
  if (!student) {
    return html(
      `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">${FONT_LINK}<style>${SHARED_CSS}</style></head>
      <body><div class="wrap">${pageHeader()}<div class="card"><h2>لینک نامعتبر است</h2>
      <p class="muted">این لینک معتبر نیست یا حذف شده است. لطفاً با معلم خود تماس بگیرید.</p></div></div></body></html>`,
      404
    );
  }

  return html(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>آزمون</title>${FONT_LINK}<style>${SHARED_CSS}</style></head>
  <body><div class="wrap">
    ${pageHeader()}
    <div class="card" id="hdr2"></div>

    <!-- مرحله ۰: انتخاب آزمون یا کاربرگ -->
    <div class="card hidden" id="step-choice">
      <h3>👋 خوش آمدید</h3>
      <p class="muted">یکی از گزینه‌های زیر را انتخاب کنید:</p>
      <div class="row" style="gap:14px;flex-wrap:wrap">
        <button class="btn" id="btn-choice-exam" style="flex:1;min-width:200px;padding:22px 16px;font-size:16px">📝 ورود به آزمون</button>
        <button class="btn sec" id="btn-choice-worksheet" style="flex:1;min-width:200px;padding:22px 16px;font-size:16px">📓 ورود به کاربرگ</button>
      </div>
    </div>

    <!-- مرحله ۱: اطلاعات دانش‌آموز -->
    <div class="card hidden" id="step-info">
      <h3>📝 اطلاعات دانش‌آموز</h3>
      <div class="row">
        <div><label>نام و نام خانوادگی *</label><input id="f-name" autocomplete="off"></div>
        <div><label>نام پدر *</label><input id="f-father" autocomplete="off"></div>
      </div>
      <div class="row">
        <div><label>کد ملی *</label><input id="f-nid" inputmode="numeric" autocomplete="off"></div>
        <div><label>تاریخ آزمون *</label><input id="f-date" autocomplete="off" placeholder="مثال: 1404/01/15"></div>
      </div>
      <p class="muted" id="info-err" style="color:var(--danger)"></p>
      <button class="btn" id="btn-enter">🚀 ورود به آزمون</button>
    </div>

    <!-- مرحله ۲: سوالات با تایمر -->
    <div class="card hidden" id="step-exam">
      <div class="exam-timer" id="timer-container">
        <div class="timer-display" id="timer-display">00:00</div>
        <div class="timer-label">⏱️ زمان باقیمانده</div>
      </div>
      <h3>📝 سوالات آزمون</h3>
      <div id="q-progress" class="muted" style="margin-bottom:10px;font-weight:600"></div>
      <div id="questions"></div>
      <button class="btn sec" id="btn-submit" style="margin-top:16px">✅ ثبت نهایی پاسخنامه</button>
    </div>

    <!-- مرحله ۳: نتیجه -->
    <div class="card hidden" id="step-done"></div>
  </div>
  <div class="toast" id="toast"></div>
  <script>
    const ID = ${JSON.stringify(id)};
    let DATA = null;
    let timerInterval = null;
    let remainingSeconds = 0;
    let isTimerExpired = false;

    function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}
    function esc(s){const d=document.createElement('div');d.textContent=s==null?'':s;return d.innerHTML;}
    function typeLabel(t){return {descriptive:'تشریحی',multiple:'چهارگزینه‌ای',truefalse:'صحیح/غلط',short:'کوتاه‌پاسخ'}[t]||t;}
    function qHtml(q){return q.rich?(q.text||''):esc(q.text);}
    function ansText(q,ans){
      if(q.type==='multiple'){const idx=parseInt(ans,10);return isNaN(idx)?'':(['الف','ب','ج','د'][idx]+') '+esc((q.options&&q.options[idx])||''));}
      if(q.type==='truefalse'){return ans==='true'?'صحیح':(ans==='false'?'غلط':'');}
      return esc(ans);
    }

    function formatTime(seconds){
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
    }

    function startTimer(seconds){
      remainingSeconds = seconds;
      isTimerExpired = false;
      const display = document.getElementById('timer-display');
      const container = document.getElementById('timer-container');
      
      if(timerInterval) clearInterval(timerInterval);
      
      timerInterval = setInterval(() => {
        remainingSeconds--;
        if(remainingSeconds <= 0){
          clearInterval(timerInterval);
          remainingSeconds = 0;
          isTimerExpired = true;
          container.className = 'exam-timer danger';
          display.textContent = '00:00';
          toast('⏰ زمان آزمون به پایان رسید! پاسخ‌ها به‌طور خودکار ثبت شدند.');
          document.getElementById('btn-submit').disabled = true;
          document.getElementById('btn-submit').textContent = '⏰ زمان تمام شد';
          submitExam(true);
          return;
        }
        
        display.textContent = formatTime(remainingSeconds);
        
        if(remainingSeconds <= 60){
          container.className = 'exam-timer danger';
        } else if(remainingSeconds <= 300){
          container.className = 'exam-timer warning';
        } else {
          container.className = 'exam-timer';
        }
      }, 1000);
    }

    async function load(){
      const r = await fetch('/api/exam/'+encodeURIComponent(ID));
      const d = await r.json();
      
      if(!d.ok){
        document.body.innerHTML = '<div class="wrap"><div class="card" style="text-align:center;padding:40px"><div style="font-size:48px;margin-bottom:16px">❌</div><h2 style="color:var(--danger)">'+esc(d.error)+'</h2><p class="muted">لطفاً با معلم خود تماس بگیرید.</p><a href="/" class="btn" style="margin-top:16px">بازگشت به صفحه اصلی</a></div></div>';
        return;
      }
      
      DATA = d;
      document.getElementById('hdr2').innerHTML = '<h3 style="margin:0">'+esc(d.meta.school || '')+'</h3>';
      
      const headerInfo = document.createElement('div');
      headerInfo.style.cssText = 'padding:12px;background:var(--card);border:1px solid var(--line);border-radius:8px;margin-bottom:16px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px';
      headerInfo.innerHTML = '<span><b>📝</b> '+esc(d.meta.examName || 'آزمون')+'</span><span><b>👨‍🏫</b> '+esc(d.meta.teacher || '')+'</span><span><b>⏱️</b> '+esc(d.meta.examDuration || '30')+' دقیقه</span>';
      document.getElementById('hdr2').after(headerInfo);
      
      if (d.submitted) {
        if(d.isExpired){
          toast('⏰ زمان آزمون به پایان رسیده است');
        }
      }

      document.getElementById('step-choice').classList.remove('hidden');
      document.getElementById('btn-choice-exam').onclick=function(){
        document.getElementById('step-choice').classList.add('hidden');
        if (d.submitted) {
          renderResult(d.result);
        } else {
          document.getElementById('step-info').classList.remove('hidden');
          try {
            const now = new Date();
            document.getElementById('f-date').value = now.toLocaleDateString('fa-IR', {year:'numeric', month:'2-digit', day:'2-digit'}).replace(/\\//g, '/');
          } catch(e) {}
        }
      };
      document.getElementById('btn-choice-worksheet').onclick=function(){
        location.href = '/w/' + encodeURIComponent(ID);
      };
    }

    function renderResult(res){
      document.getElementById('step-exam').classList.add('hidden');
      const done=document.getElementById('step-done');
      done.classList.remove('hidden');
      
      if(!res.grading || !res.grading.graded){
        done.innerHTML = \`
          <div class="result-card">
            <div style="text-align:center;font-size:48px;margin-bottom:12px">✅</div>
            <h2 style="text-align:center;color:var(--primary)">پاسخنامه‌ی شما با موفقیت ثبت شد</h2>
            <p class="muted" style="text-align:center">پاسخ‌های شما برای معلم ارسال شد. نتیجه‌ی آزمون پس از تصحیح توسط معلم، در این صفحه نمایش داده می‌شود.</p>
          </div>
        \`;
        return;
      }
      
      const g=res.grading;
      const isNumeric = g.marks && Object.values(g.marks).some(v => !isNaN(parseFloat(v)));
      
      const statusIcons = {
        excellent: '🌟',
        good: '✅',
        acceptable: '📌',
        'needs-improve': '📖',
        correct: '✅',
        wrong: '❌',
        partial: '⚠️'
      };
      
      // تغییر: «عالی» به «خیلی خوب»
      const statusLabels = {
        excellent: 'خیلی خوب',
        good: 'خوب',
        acceptable: 'قابل‌قبول',
        'needs-improve': 'نیاز به تلاش',
        correct: 'صحیح',
        wrong: 'غلط',
        partial: 'نیمه‌درست'
      };
      
      // محاسبه نمره کل از 20
      let totalWeight = 0;
      res.questions.forEach(q => {
        totalWeight += (q.weight || 1);
      });
      
      // اگر وزن‌ها جمعش 20 نشده، نرمالایز میکنیم
      const totalWeightNormalized = totalWeight || 20;
      
      let rows = res.questions.map((q, i) => {
        const ans = res.answers[q.id];
        const mark = g.marks[q.id] || '';
        const fb = g.feedback[q.id] || '';
        const weight = q.weight || 1;
        
        let resultCell;
        if(isNumeric){
          const score = parseFloat(mark);
          const scoreText = isNaN(score) ? '—' : score.toFixed(1);
          // نمره از 20 بر اساس وزن سوال
          const maxScore = (weight / totalWeightNormalized) * 20;
          resultCell = \`
            <div style="display:flex;flex-direction:column;align-items:center;gap:4px">
              <span class="mark numeric">\${scoreText} از \${maxScore.toFixed(1)}</span>
            </div>
          \`;
        } else {
          const statusClass = mark || '';
          const icon = statusIcons[mark] || '';
          const label = statusLabels[mark] || mark || '—';
          resultCell = \`<span class="status-badge \${statusClass}">\${icon} \${label}</span>\`;
        }
        
        return \`<tr>
          <td>\${i + 1}</td>
          <td>\${qHtml(q)}\${q.image ? '<br><img src="'+q.image+'" class="imgprev" style="max-width:'+(q.imageWidth||320)+'px;width:100%">' : ''}</td>
          <td>\${ansText(q, ans) || '<i>بدون پاسخ</i>'}</td>
          <td>\${resultCell}</td>
          <td>\${esc(fb) || '—'}</td>
        </tr>\`;
      }).join('');
      
      let totalScore = '';
      if(isNumeric){
        let total = 0;
        res.questions.forEach(q => {
          const score = parseFloat(g.marks[q.id] || 0);
          if (!isNaN(score)) total += score;
        });
        // نمره کل از 20
        const finalScore = Math.min(20, Math.max(0, total));
        const percent = Math.round((finalScore / 20) * 100);
        let gradeIcon = '🌟';
        if(percent >= 80) { gradeIcon = '🌟'; }
        else if(percent >= 60) { gradeIcon = '✅'; }
        else if(percent >= 40) { gradeIcon = '📌'; }
        else { gradeIcon = '📖'; }
        
        totalScore = \`
          <div class="total-score">
            \${gradeIcon} <b>نمره کل: \${finalScore.toFixed(1)} از 20</b> 
            <span style="font-size:14px;font-weight:400;color:var(--muted)">(\${percent}٪)</span>
          </div>
        \`;
      }
      
      done.innerHTML = \`
        <div class="result-card">
          <h2 style="text-align:center;color:var(--primary);margin-bottom:8px">📝 نتیجه آزمون</h2>
          \${totalScore}
          <div style="display:flex;flex-wrap:wrap;gap:8px;padding:12px;background:var(--bg);border-radius:10px;margin-bottom:16px">
            <span><b>👤 نام:</b> \${esc(res.student.name)}</span>
            <span><b>📚 درس:</b> \${esc(res.student.courseName || '')}</span>
            <span><b>📅 تاریخ:</b> \${esc(res.student.examDate || '')}</span>
            <span><b>👨‍👦 نام پدر:</b> \${esc(res.student.fatherName || '')}</span>
          </div>
          <div style="overflow-x:auto">
            <table class="result-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>سوال</th>
                  <th>پاسخ شما</th>
                  <th>نمره</th>
                  <th>بازخورد</th>
                </tr>
              </thead>
              <tbody>\${rows}</tbody>
            </table>
          </div>
          \${g.overall ? \`
            <div style="margin-top:16px;padding:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px">
              <b>💬 بازخورد کلی معلم:</b>
              <p style="margin-top:8px;font-size:15px;line-height:1.8">\${esc(g.overall)}</p>
            </div>
          \` : ''}
        </div>
      \`;
    }

    function renderQuestions(){
      const box=document.getElementById('questions');
      if(!DATA.questions.length){box.innerHTML='<p class="muted">هنوز سوالی توسط معلم طراحی نشده است.</p>';document.getElementById('btn-submit').classList.add('hidden');return;}
      box.innerHTML = DATA.questions.map((q,i)=>{
        let body='';
        if(q.type==='multiple'){
          body=(q.options||[]).map((o,oi)=>'<div class="opt-row"><label style="font-weight:400;margin:0"><input type="radio" name="q_'+q.id+'" value="'+oi+'" style="width:auto;margin-left:6px"> '+['الف','ب','ج','د'][oi]+') '+esc(o)+'</label></div>').join('');
        }else if(q.type==='truefalse'){
          body='<div class="opt-row"><label style="font-weight:400;margin:0"><input type="radio" name="q_'+q.id+'" value="true" style="width:auto;margin-left:6px"> ✅ صحیح</label>&nbsp;&nbsp;<label style="font-weight:400;margin:0"><input type="radio" name="q_'+q.id+'" value="false" style="width:auto;margin-left:6px"> ❌ غلط</label></div>';
        }else if(q.type==='short'){
          body='<input type="text" data-q="'+q.id+'" autocomplete="off" placeholder="پاسخ خود را وارد کنید...">';
        }else{
          body='<textarea data-q="'+q.id+'" placeholder="پاسخ خود را بنویسید..."></textarea>'+
            '<div style="margin-top:8px">'+
            '<label class="btn sm secondary" style="display:inline-block;cursor:pointer" for="photo_'+q.id+'">📷 یا عکس پاسخ خود را بارگذاری کنید</label>'+
            '<input type="file" accept="image/*" id="photo_'+q.id+'" data-qphoto="'+q.id+'" class="hidden">'+
            '<span class="muted" id="photostatus_'+q.id+'" style="margin-right:8px"></span>'+
            '<div id="photopreview_'+q.id+'" style="margin-top:8px"></div>'+
            '</div>';
        }
        const img=q.image?'<div><img src="'+q.image+'" class="imgprev" style="max-width:'+(q.imageWidth||320)+'px;width:100%;cursor:zoom-in" onclick="window.open(this.src)" title="برای بزرگ‌نمایی کلیک کنید"><div class="muted" style="font-size:11px;margin-top:2px">🔍 برای بزرگ‌نمایی روی عکس کلیک کنید</div></div>':'';
        const weightInfo = q.weight ? \`<span style="font-size:11px;color:#64748b;margin-right:8px">(وزن: \${q.weight})</span>\` : '';
        const isLast=i===DATA.questions.length-1;
        const nextBtn=isLast?'':'<div style="margin-top:14px"><button type="button" class="btn primary q-next-btn" data-qnext="'+i+'">✅ ثبت و ادامه</button></div>';
        return '<div class="q-block q-step" data-qindex="'+i+'" style="'+(i===0?'':'display:none')+'"><div class="qhead"><b>'+(i+1)+'. '+qHtml(q)+'</b><span class="badge">'+typeLabel(q.type)+weightInfo+'</span></div>'+img+body+nextBtn+'</div>';
      }).join('');
      document.getElementById('btn-submit').classList.toggle('hidden', DATA.questions.length>1);
      updateQProgress(0);
    }

    function updateQProgress(curIdx){
      const el=document.getElementById('q-progress');
      if(!el)return;
      el.textContent = DATA.questions.length>1 ? ('سوال '+(curIdx+1)+' از '+DATA.questions.length) : '';
    }

    function isQuestionAnswered(q){
      if(q.type==='multiple'||q.type==='truefalse'){
        return !!document.querySelector('input[name="q_'+q.id+'"]:checked');
      }
      const el=document.querySelector('[data-q="'+q.id+'"]');
      const hasText = el && el.value.trim()!=='';
      const hasPhoto = !!PHOTO_ANSWERS[q.id];
      return hasText||hasPhoto;
    }

    document.getElementById('questions').addEventListener('click', function(e){
      const btn=e.target.closest('.q-next-btn');
      if(!btn)return;
      const idx=parseInt(btn.dataset.qnext,10);
      const q=DATA.questions[idx];
      if(!isQuestionAnswered(q)){
        toast('⚠️ لطفاً پیش از ادامه، به این سوال پاسخ دهید');
        return;
      }
      const curStep=document.querySelector('.q-step[data-qindex="'+idx+'"]');
      const nextStep=document.querySelector('.q-step[data-qindex="'+(idx+1)+'"]');
      if(curStep)curStep.style.display='none';
      if(nextStep){
        nextStep.style.display='';
        nextStep.scrollIntoView({behavior:'smooth',block:'start'});
      }
      updateQProgress(idx+1);
      if(idx+1===DATA.questions.length-1){
        document.getElementById('btn-submit').classList.remove('hidden');
      }
    });

    // ===== بارگذاری عکس پاسخ (برای سوالات تشریحی) با فشرده‌سازی خودکار زیر ۲ مگابایت =====
    let PHOTO_ANSWERS={};
    function compressImageToUnder2MB(file){
      return new Promise(function(resolve,reject){
        const reader=new FileReader();
        reader.onload=function(ev){
          const img=new Image();
          img.onload=function(){
            let w=img.width,h=img.height;
            const maxDim=2000;
            if(Math.max(w,h)>maxDim){
              const scale=maxDim/Math.max(w,h);
              w=Math.round(w*scale);h=Math.round(h*scale);
            }
            const canvas=document.createElement('canvas');
            canvas.width=w;canvas.height=h;
            const ctx=canvas.getContext('2d');
            ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);
            ctx.drawImage(img,0,0,w,h);
            let quality=0.9;
            function tryCompress(){
              canvas.toBlob(function(blob){
                if(!blob){reject(new Error('خطا در فشرده‌سازی'));return;}
                if(blob.size<=2*1024*1024||quality<=0.3){
                  const fr=new FileReader();
                  fr.onload=function(){resolve({dataUrl:fr.result,size:blob.size});};
                  fr.readAsDataURL(blob);
                }else{
                  quality-=0.1;
                  tryCompress();
                }
              },'image/jpeg',quality);
            }
            tryCompress();
          };
          img.onerror=function(){reject(new Error('فایل عکس معتبر نیست'));};
          img.src=ev.target.result;
        };
        reader.onerror=function(){reject(new Error('خطا در خواندن فایل'));};
        reader.readAsDataURL(file);
      });
    }
    document.getElementById('questions').addEventListener('change',async function(e){
      const target=e.target;
      if(!target||!target.dataset||!target.dataset.qphoto)return;
      const qid=target.dataset.qphoto;
      const file=target.files[0];
      if(!file)return;
      const statusEl=document.getElementById('photostatus_'+qid);
      const previewEl=document.getElementById('photopreview_'+qid);
      statusEl.textContent='در حال فشرده‌سازی...';
      try{
        const result=await compressImageToUnder2MB(file);
        PHOTO_ANSWERS[qid]=result.dataUrl;
        statusEl.textContent='آماده ✅ (حجم نهایی حدود '+(result.size/1024/1024).toFixed(2)+' مگابایت)';
        previewEl.innerHTML='<img src="'+result.dataUrl+'" style="max-width:220px;border:1px solid #ddd;border-radius:8px">';
      }catch(err){
        statusEl.textContent='خطا در پردازش عکس — لطفاً دوباره تلاش کنید';
      }
    });

    async function submitExam(autoSubmit = false){
      const answers={};
      DATA.questions.forEach(q=>{
        if(q.type==='multiple'||q.type==='truefalse'){
          const sel=document.querySelector('input[name="q_'+q.id+'"]:checked');
          answers[q.id]=sel?sel.value:'';
        }else{
          const el=document.querySelector('[data-q="'+q.id+'"]');
          answers[q.id]=el?el.value:'';
        }
      });
      
      const btn=document.getElementById('btn-submit');
      btn.disabled=true;
      btn.textContent=autoSubmit ? '⏰ ارسال خودکار...' : 'در حال ثبت...';
      
      try {
        const r=await fetch('/api/exam/'+encodeURIComponent(ID)+'/submit',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({...window._student, answers, photoAnswers:PHOTO_ANSWERS})
        });
        const d=await r.json();
        if(d.ok){
          document.getElementById('step-exam').classList.add('hidden');
          renderResult({grading:null});
          if(autoSubmit){
            toast('⏰ زمان تمام شد! پاسخنامه شما به طور خودکار ثبت شد.');
          }
        }else{
          toast(d.error||'خطا در ثبت');
          btn.disabled=false;
          btn.textContent='✅ ثبت نهایی پاسخنامه';
        }
      } catch(e) {
        toast('خطا در اتصال');
        btn.disabled=false;
        btn.textContent='✅ ثبت نهایی پاسخنامه';
      }
    }

    document.getElementById('btn-enter').onclick=()=>{
      const name=document.getElementById('f-name').value.trim();
      const father=document.getElementById('f-father').value.trim();
      const nid=document.getElementById('f-nid').value.trim();
      const date=document.getElementById('f-date').value.trim();
      const err=document.getElementById('info-err');
      if(!name||!father||!nid||!date){err.textContent='لطفاً همه فیلدها را پر کنید.';return;}
      err.textContent='';
      const course=(DATA && DATA.meta && DATA.meta.examName) || '';
      window._student={name,fatherName:father,nationalId:nid,courseName:course,examDate:date};
      document.getElementById('step-info').classList.add('hidden');
      document.getElementById('step-exam').classList.remove('hidden');
      renderQuestions();
      
      if(DATA.duration){
        startTimer(DATA.duration);
      }
    };

    document.getElementById('btn-submit').onclick=()=>{
      if(confirm('آیا از ثبت نهایی پاسخنامه مطمئن هستید؟')) {
        submitExam(false);
      }
    };

    try{ 
      const now = new Date();
      document.getElementById('f-date').value = now.toLocaleDateString('fa-IR', {year:'numeric', month:'2-digit', day:'2-digit'}).replace(/\\//g, '/');
    }catch(e){}
    load();
  </script></body></html>`);
}

/* ------------------------- کاربرگ - صفحه دانش‌آموز ------------------------- */

async function workSheetPage(env, id) {
  const student = await env.EXAM_KV.get("student:" + id);
  if (!student) {
    return html(
      `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">${FONT_LINK}<style>${SHARED_CSS}</style></head>
      <body><div class="wrap">${pageHeader()}<div class="card"><h2>لینک نامعتبر است</h2>
      <p class="muted">این لینک معتبر نیست یا حذف شده است. لطفاً با معلم خود تماس بگیرید.</p></div></div></body></html>`,
      404
    );
  }

  return html(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>کاربرگ</title>${FONT_LINK}<style>${SHARED_CSS}</style></head>
  <body><div class="wrap">
    ${pageHeader()}
    <div class="card">
      <h2>📓 کاربرگ</h2>
      <div id="ws-label" class="muted" style="margin-bottom:14px"></div>

      <div id="ws-teacher-file-box">
        <h3>📄 کاربرگ ارسالی معلم</h3>
        <div id="ws-teacher-file-content" class="muted">در حال بارگذاری...</div>
      </div>

      <hr style="border:none;border-top:1px solid var(--line);margin:18px 0">

      <div id="ws-upload-box">
        <h3>📷 ارسال کاربرگ انجام‌شده</h3>
        <p class="muted">پس از انجام کاربرگ، از آن عکس بگیرید (می‌توانید چند عکس بفرستید) و اینجا بارگذاری کنید.</p>
        <input type="file" id="ws-photo-file" accept="image/*" multiple class="hidden">
        <label class="btn sec" for="ws-photo-file" style="cursor:pointer;display:inline-block">📷 انتخاب عکس(ها)</label>
        <span class="muted" id="ws-photo-status" style="margin-right:8px"></span>
        <div id="ws-photo-preview" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"></div>
        <button class="btn primary" id="ws-btn-submit" style="margin-top:14px">✅ ارسال برای معلم</button>
      </div>

      <div id="ws-submitted-box" class="hidden" style="margin-top:18px">
        <h3>✅ کاربرگ شما ارسال شد</h3>
        <div id="ws-submitted-photos" style="display:flex;gap:8px;flex-wrap:wrap"></div>
      </div>

      <div id="ws-feedback-box" class="hidden" style="margin-top:18px;padding:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px">
        <h3 style="margin-top:0">💬 بازخورد معلم</h3>
        <div id="ws-feedback-text" style="white-space:pre-wrap;line-height:1.8"></div>
      </div>
    </div>
  </div>
  <div class="toast" id="toast"></div>
  <script>
    const ID=${JSON.stringify(id)};
    function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.style.opacity='1';setTimeout(()=>t.style.opacity='0',2600);}
    async function api(path,opts){const r=await fetch(path,opts);return r.json();}

    let PENDING_PHOTOS=[];

    function compressImageToUnder2MB(file){
      return new Promise(function(resolve,reject){
        const reader=new FileReader();
        reader.onload=function(ev){
          const img=new Image();
          img.onload=function(){
            let w=img.width,h=img.height;
            const maxDim=2000;
            if(Math.max(w,h)>maxDim){
              const scale=maxDim/Math.max(w,h);
              w=Math.round(w*scale);h=Math.round(h*scale);
            }
            const canvas=document.createElement('canvas');
            canvas.width=w;canvas.height=h;
            const ctx=canvas.getContext('2d');
            ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);
            ctx.drawImage(img,0,0,w,h);
            let quality=0.9;
            function tryCompress(){
              canvas.toBlob(function(blob){
                if(!blob){reject(new Error('خطا در فشرده‌سازی'));return;}
                if(blob.size<=2*1024*1024||quality<=0.3){
                  const fr=new FileReader();
                  fr.onload=function(){resolve(fr.result);};
                  fr.readAsDataURL(blob);
                }else{
                  quality-=0.1;
                  tryCompress();
                }
              },'image/jpeg',quality);
            }
            tryCompress();
          };
          img.onerror=function(){reject(new Error('فایل عکس معتبر نیست'));};
          img.src=ev.target.result;
        };
        reader.onerror=function(){reject(new Error('خطا در خواندن فایل'));};
        reader.readAsDataURL(file);
      });
    }

    function renderPendingPreview(){
      const box=document.getElementById('ws-photo-preview');
      box.innerHTML=PENDING_PHOTOS.map(function(p,i){
        return '<div style="position:relative"><img src="'+p+'" style="width:90px;height:90px;object-fit:cover;border-radius:8px;border:1px solid #ddd">'+
          '<button type="button" data-rm="'+i+'" style="position:absolute;top:-6px;left:-6px;background:#dc2626;color:#fff;border:none;border-radius:50%;width:22px;height:22px;cursor:pointer">✕</button></div>';
      }).join('');
    }
    document.getElementById('ws-photo-preview').addEventListener('click',function(e){
      const btn=e.target.closest('[data-rm]');
      if(!btn)return;
      PENDING_PHOTOS.splice(parseInt(btn.dataset.rm,10),1);
      renderPendingPreview();
    });
    document.getElementById('ws-photo-file').addEventListener('change',async function(e){
      const files=Array.from(e.target.files||[]);
      if(!files.length)return;
      const statusEl=document.getElementById('ws-photo-status');
      statusEl.textContent='در حال فشرده‌سازی...';
      try{
        for(const f of files){
          if(PENDING_PHOTOS.length>=6){toast('حداکثر ۶ عکس مجاز است');break;}
          const dataUrl=await compressImageToUnder2MB(f);
          PENDING_PHOTOS.push(dataUrl);
        }
        renderPendingPreview();
        statusEl.textContent='آماده ✅';
      }catch(err){
        statusEl.textContent='خطا در پردازش عکس — لطفاً دوباره تلاش کنید';
      }
      e.target.value='';
    });

    document.getElementById('ws-btn-submit').onclick=async function(){
      if(!PENDING_PHOTOS.length){toast('لطفاً حداقل یک عکس انتخاب کنید');return;}
      const btn=document.getElementById('ws-btn-submit');
      btn.disabled=true;btn.textContent='در حال ارسال...';
      try{
        const d=await api('/api/worksheet/'+encodeURIComponent(ID)+'/submit',{
          method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({photos:PENDING_PHOTOS})
        });
        if(d.ok){
          toast('کاربرگ شما ارسال شد ✅');
          document.getElementById('ws-upload-box').classList.add('hidden');
          document.getElementById('ws-submitted-box').classList.remove('hidden');
          document.getElementById('ws-submitted-photos').innerHTML=PENDING_PHOTOS.map(function(p){
            return '<img src="'+p+'" style="width:110px;height:110px;object-fit:cover;border-radius:8px;border:1px solid #ddd">';
          }).join('');
        }else{
          toast(d.error||'خطا در ارسال');
          btn.disabled=false;btn.textContent='✅ ارسال برای معلم';
        }
      }catch(err){
        toast('خطا در اتصال');
        btn.disabled=false;btn.textContent='✅ ارسال برای معلم';
      }
    };

    async function load(){
      const d=await api('/api/worksheet/'+encodeURIComponent(ID));
      if(!d.ok){document.getElementById('ws-teacher-file-content').textContent='خطا در بارگذاری اطلاعات';return;}
      document.getElementById('ws-label').textContent=d.label?('دانش‌آموز: '+d.label):'';
      const tBox=document.getElementById('ws-teacher-file-content');
      if(d.teacherFile){
        if(d.teacherFileType==='pdf'){
          tBox.innerHTML='<a class="btn sec" href="'+d.teacherFile+'" download="'+(d.teacherFileName||'کاربرگ.pdf')+'">⬇️ دانلود فایل PDF کاربرگ ('+(d.teacherFileName||'')+')</a>';
        }else{
          tBox.innerHTML='<img src="'+d.teacherFile+'" style="max-width:100%;border-radius:10px;border:1px solid #ddd">';
        }
      }else{
        tBox.textContent='هنوز کاربرگی توسط معلم ارسال نشده است.';
      }
      if(d.studentFiles&&d.studentFiles.length){
        document.getElementById('ws-upload-box').classList.add('hidden');
        document.getElementById('ws-submitted-box').classList.remove('hidden');
        document.getElementById('ws-submitted-photos').innerHTML=d.studentFiles.map(function(p){
          return '<img src="'+p+'" style="width:110px;height:110px;object-fit:cover;border-radius:8px;border:1px solid #ddd">';
        }).join('');
      }
      if(d.feedback){
        document.getElementById('ws-feedback-box').classList.remove('hidden');
        document.getElementById('ws-feedback-text').textContent=d.feedback;
      }
    }
    load();
  </script></body></html>`);
}

/* ------------------------- کلاس آنلاین - صفحه دانش‌آموز ------------------------- */

async function studentClassPage(env, id) {
  const raw = await env.EXAM_KV.get("student:" + id);
  if (!raw) {
    return html(
      `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">${FONT_LINK}<style>${SHARED_CSS}</style></head>
      <body><div class="wrap">${pageHeader()}<div class="card"><h2>لینک نامعتبر است</h2>
      <p class="muted">این لینک کلاس آنلاین معتبر نیست یا حذف شده است. لطفاً با معلم خود تماس بگیرید.</p></div></div></body></html>`,
      404
    );
  }
  const student = JSON.parse(raw);

  return html(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>کلاس آنلاین</title>${FONT_LINK}<style>${SHARED_CSS}
    .cls-wrap{display:flex;gap:12px;flex-wrap:wrap}
    #board{width:100%;background:#fff;border:1px solid var(--line);border-radius:10px;touch-action:none;display:block}
    .cls-status{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
    .dot{width:10px;height:10px;border-radius:50%;background:#dc2626;display:inline-block}
    .dot.on{background:#16a34a}
    #chatBox{height:360px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:10px;background:#fafafa;display:flex;flex-direction:column;gap:6px}
    .msg{padding:6px 10px;border-radius:10px;max-width:90%;font-size:14px}
    .msg.teacher{background:#eef2ff;align-self:flex-start}
    .msg.student{background:#dcfce7;align-self:flex-end}
    .msg .who{font-size:11px;color:#666;margin-bottom:2px}
  </style></head>
  <body><div class="wrap">
    ${pageHeader()}
    <div class="card">
      <h3>🖥️ کلاس آنلاین${student.label ? " — " + esc(student.label) : ""}</h3>
      <div class="cls-status">
        <span class="dot" id="cls-dot"></span>
        <span id="cls-status-text" class="muted">در حال اتصال به کلاس...</span>
        <span style="flex:1"></span>
        <button class="btn sm sec" id="btn-raise-hand">✋ بلند کردن دست</button>
        <button class="btn sm" id="btn-enable-sound">🔊 فعال‌سازی صدای کلاس</button>
      </div>
      <div class="cls-wrap">
        <div class="cls-board-col">
          <img id="cls-teacher-video" class="hidden" style="width:100%;max-width:280px;border-radius:10px;border:1px solid var(--line);margin-bottom:10px;background:#000;display:block">
          <canvas id="board" width="900" height="500"></canvas>
          <p class="muted" style="font-size:12px;margin-top:6px">تخته کلاس توسط معلم کنترل می‌شود. صدای معلم به‌صورت خودکار پخش می‌شود.</p>
        </div>
        <div class="cls-chat-col">
          <div id="chatBox"></div>
          <div class="row" style="margin-top:8px">
            <input id="chatInput" placeholder="پیام خود را بنویسید...">
            <button class="btn sm" id="btnSend" style="flex:0 0 auto">ارسال</button>
            <button class="btn sm gray" id="btnFile" style="flex:0 0 auto" title="ارسال فایل">📎</button>
            <input type="file" id="fileInput" style="display:none">
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="toast" id="toast"></div>
  <script>
    const ID = ${JSON.stringify(id)};
    const NAME = ${JSON.stringify(student.label || "دانش‌آموز")};
    function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}
    function esc(s){const d=document.createElement('div');d.textContent=s==null?'':s;return d.innerHTML;}

    const canvas=document.getElementById('board');
    const ctx=canvas.getContext('2d');
    const BOARD_DEFAULT_W=900, BOARD_DEFAULT_H=560;
    function resizeCanvas(){
      const ratio=canvas.height/canvas.width;
      const containerW=canvas.parentElement.clientWidth;
      if(!containerW)return;
      const maxH=window.innerHeight*0.7; // در گوشی هم جا می‌شود، بدون نیاز به اسکرول زیاد
      let w=containerW, h=w*ratio;
      if(h>maxH){h=maxH;w=h/ratio;}
      canvas.style.width=w+'px';
      canvas.style.height=h+'px';
    }
    function resizeCanvasTo(w,h){
      canvas.width=Math.round(w);
      canvas.height=Math.round(h);
      resizeCanvas();
    }
    resizeCanvas();window.addEventListener('resize',resizeCanvas);

    function drawStroke(s){
      if(!s)return;
      if(s.type==='text'){
        ctx.save();
        ctx.fillStyle=s.color||'#111827';
        ctx.font='bold '+((s.size||3)*7+12)+'px Vazirmatn, Tahoma, sans-serif';
        ctx.textBaseline='top';
        ctx.fillText(s.text||'', s.x*canvas.width, s.y*canvas.height);
        ctx.restore();
        return;
      }
      if(!s.points||s.points.length<2)return;
      ctx.save();
      ctx.strokeStyle=s.erase?'#ffffff':(s.color||'#111827');
      ctx.lineWidth=s.size||3;
      ctx.lineCap='round';ctx.lineJoin='round';
      ctx.beginPath();
      ctx.moveTo(s.points[0][0]*canvas.width,s.points[0][1]*canvas.height);
      for(let i=1;i<s.points.length;i++)ctx.lineTo(s.points[i][0]*canvas.width,s.points[i][1]*canvas.height);
      ctx.stroke();
      ctx.restore();
    }
    function clearBoard(){ctx.clearRect(0,0,canvas.width,canvas.height);}

    // ===== لایه‌ی پس‌زمینه (صفحه‌ی PDF که معلم روی تخته گذاشته) =====
    let boardBgImg=null;
    function setBoardBg(dataUrl,w,h){
      if(!dataUrl){
        boardBgImg=null;
        resizeCanvasTo(w||BOARD_DEFAULT_W,h||BOARD_DEFAULT_H);
        ctx.clearRect(0,0,canvas.width,canvas.height);
        return;
      }
      const img=new Image();
      img.onload=()=>{
        boardBgImg=img;
        resizeCanvasTo(w||img.naturalWidth,h||img.naturalHeight);
        ctx.clearRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(img,0,0,canvas.width,canvas.height);
      };
      img.src=dataUrl;
    }
    function setBoardBgAndReplay(dataUrl,strokes,w,h){
      if(!dataUrl){
        boardBgImg=null;
        resizeCanvasTo(w||BOARD_DEFAULT_W,h||BOARD_DEFAULT_H);
        ctx.clearRect(0,0,canvas.width,canvas.height);
        (strokes||[]).forEach(drawStroke);
        return;
      }
      const img=new Image();
      img.onload=()=>{
        boardBgImg=img;
        resizeCanvasTo(w||img.naturalWidth,h||img.naturalHeight);
        ctx.clearRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(img,0,0,canvas.width,canvas.height);
        (strokes||[]).forEach(drawStroke);
      };
      img.src=dataUrl;
    }

    // ===== پخش صدای زنده معلم با MediaSource =====
    let audioQueue=[], audioPlaying=false, audioWarned=false, audioUnlocked=false;
    (function setupSoundUnlock(){
      const btn=document.getElementById('btn-enable-sound');
      btn.onclick=function(){
        // پخش یک صدای خیلی کوتاه و بی‌صدا برای باز کردن قفل پخش خودکار صدا در مرورگر
        const a=new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=');
        a.play().then(()=>{audioUnlocked=true;btn.classList.add('hidden');pumpAudioQueue();}).catch(()=>{audioUnlocked=true;btn.classList.add('hidden');pumpAudioQueue();});
      };
    })();
    function playAudioChunk(b64, mime){
      audioQueue.push({b64, mime: mime||'audio/webm'});
      if(audioQueue.length>3) audioQueue.splice(0, audioQueue.length-3); // اگر پخش عقب افتاد، فقط تازه‌ترین‌ها را نگه دار تا صدا زنده‌تر بماند
      pumpAudioQueue();
    }
    function pumpAudioQueue(){
      if(!audioUnlocked||audioPlaying||audioQueue.length===0) return;
      const item=audioQueue.shift();
      const a=new Audio('data:'+item.mime+';base64,'+item.b64);
      audioPlaying=true;
      a.onended=()=>{ audioPlaying=false; pumpAudioQueue(); };
      a.onerror=()=>{
        audioPlaying=false;
        if(!audioWarned){
          audioWarned=true;
          toast('مرورگر شما امکان پخش صدای معلم را ندارد؛ لطفاً Chrome را امتحان کنید');
        }
        pumpAudioQueue();
      };
      a.play().catch(()=>{ audioPlaying=false; pumpAudioQueue(); });
    }

    function addChatMsg(entry){
      const box=document.getElementById('chatBox');
      const cls=entry.role==='teacher'?'teacher':'student';
      box.insertAdjacentHTML('beforeend','<div class="msg '+cls+'"><div class="who">'+esc(entry.from)+'</div>'+esc(entry.text)+'</div>');
      box.scrollTop=box.scrollHeight;
    }
    function addFileMsg(f){
      const box=document.getElementById('chatBox');
      const cls=f.role==='teacher'?'teacher':'student';
      let inner;
      if((f.mime||'').indexOf('image/')===0){
        inner='<a href="'+f.data+'" download="'+esc(f.name)+'" target="_blank"><img src="'+f.data+'" style="max-width:180px;max-height:180px;border-radius:8px;display:block"></a>';
      } else {
        inner='<a href="'+f.data+'" download="'+esc(f.name)+'" style="color:#2563eb;text-decoration:underline">📎 '+esc(f.name)+'</a>';
      }
      box.insertAdjacentHTML('beforeend','<div class="msg '+cls+'"><div class="who">'+esc(f.from)+'</div>'+inner+'</div>');
      box.scrollTop=box.scrollHeight;
    }

    let ws=null, checkFailCount=0;
    async function connect(){
      const proto=location.protocol==='https:'?'wss:':'ws:';
      try{
        const chk=await fetch('/api/classroom/ws?check=1&role=student&id='+encodeURIComponent(ID));
        const chkData=await chk.json().catch(()=>({ok:false,error:'پاسخ نامعتبر از سرور'}));
        if(!chkData.ok){
          document.getElementById('cls-status-text').textContent='خطا: '+chkData.error;
          return; // دیگر تلاش مجدد نمی‌کنیم چون مشکل پیکربندی است، نه اتصال موقت
        }
      }catch(e){
        checkFailCount++;
        document.getElementById('cls-status-text').textContent='اتصال به سرور برقرار نشد، در حال تلاش مجدد...';
        setTimeout(connect,2000);
        return;
      }
      ws=new WebSocket(proto+'//'+location.host+'/api/classroom/ws?role=student&id='+encodeURIComponent(ID)+'&name='+encodeURIComponent(NAME));
      ws.onopen=()=>{document.getElementById('cls-dot').classList.add('on');document.getElementById('cls-status-text').textContent='متصل به کلاس آنلاین ✅';};
      ws.onclose=()=>{document.getElementById('cls-dot').classList.remove('on');document.getElementById('cls-status-text').textContent='اتصال قطع شد، در حال تلاش مجدد...';setTimeout(connect,2000);};
      ws.onerror=()=>{try{ws.close();}catch(e){}};
      ws.onmessage=(evt)=>{
        let m;try{m=JSON.parse(evt.data);}catch(e){return;}
        if(m.type==='init'){
          if(m.boardBg){setBoardBgAndReplay(m.boardBg,m.strokes||[],m.boardBgW,m.boardBgH);}
          else{clearBoard();boardBgImg=null;(m.strokes||[]).forEach(drawStroke);}
          (m.chat||[]).forEach(addChatMsg);
        }
        else if(m.type==='draw'){drawStroke(m.stroke);}
        else if(m.type==='clear'){ctx.clearRect(0,0,canvas.width,canvas.height);if(boardBgImg)ctx.drawImage(boardBgImg,0,0,canvas.width,canvas.height);}
        else if(m.type==='board-bg'){setBoardBg(m.data,m.w,m.h);}
        else if(m.type==='audio'){playAudioChunk(m.data, m.mime);}
        else if(m.type==='video-frame'){
          const img=document.getElementById('cls-teacher-video');
          img.src=m.data;
          img.classList.remove('hidden');
        }
        else if(m.type==='video-stop'){
          const img=document.getElementById('cls-teacher-video');
          img.classList.add('hidden');
          img.src='';
        }
        else if(m.type==='chat'){addChatMsg(m.entry);}
        else if(m.type==='file'){addFileMsg(m);}
        else if(m.type==='presence'){ if(m.event==='join'&&m.role==='teacher')toast('معلم وارد کلاس شد');}
      };
    }
    connect();

    document.getElementById('btnSend').onclick=()=>{
      const inp=document.getElementById('chatInput');
      const text=inp.value.trim();
      if(!text||!ws||ws.readyState!==1)return;
      ws.send(JSON.stringify({type:'chat',text}));
      inp.value='';
    };
    document.getElementById('chatInput').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('btnSend').click();});
    document.getElementById('btnFile').onclick=()=>{document.getElementById('fileInput').click();};
    document.getElementById('fileInput').addEventListener('change',function(){
      const file=this.files&&this.files[0];
      this.value='';
      if(!file)return;
      if(!ws||ws.readyState!==1){toast('ابتدا باید به کلاس متصل باشید');return;}
      if(file.size>2*1024*1024){toast('حجم فایل باید کمتر از ۲ مگابایت باشد');return;}
      const reader=new FileReader();
      reader.onload=function(){
        ws.send(JSON.stringify({type:'file', name:file.name, mime:file.type, data:reader.result}));
      };
      reader.readAsDataURL(file);
    });
    document.getElementById('btn-raise-hand').onclick=()=>{if(ws&&ws.readyState===1){ws.send(JSON.stringify({type:'raise-hand'}));toast('دستت بلند شد ✋');}};
  </script></body></html>`);
}

/* ------------------------- پنل معلم (کامل) ------------------------- */

function teacherPage() {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(APP_TITLE)}</title>${FONT_LINK}<style>${SHARED_CSS}</style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <script>pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';</script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"></script>
  </head>
  <body><div class="wrap">
    ${pageHeader()}

    <div class="card" id="login">
      <h3 id="login-head">🔐 ورود معلم</h3>
      <p class="muted" id="login-hint"></p>
      <label>رمز عبور</label><input id="pass" type="password" autocomplete="current-password">
      <p class="muted" id="login-err" style="color:var(--danger)"></p>
      <button class="btn" id="btn-login">ورود</button>
    </div>

    <div id="dash" class="hidden">
      <div class="tabs">
        <div class="tab active" data-tab="examonline">🎓 آزمون آنلاین</div>
        <div class="tab" data-tab="examsheet">🖨️ ساخت آزمون</div>
        <div class="tab" data-tab="schedule">📅 برنامه هفتگی</div>
        <div class="tab" data-tab="tablesorg">📊 جدول‌ساز</div>
        <div class="tab" data-tab="imgtools">🖼️ ابزار عکس</div>
        <div class="tab" data-tab="translateai">🌐🤖 ترجمه و هوش مصنوعی</div>
        <div class="tab" data-tab="classroom">🖥️ کلاس آنلاین</div>
        <div class="tab" data-tab="logbook">📔 دفتر مدیریت کلاسی</div>
        <div class="tab" data-tab="settings">⚙️ تنظیمات</div>
        <div style="flex:1"></div>
        <div class="tab" id="btn-logout" style="background:#fee2e2;color:#991b1b">🚪 خروج</div>
      </div>

      <div class="card tab-content" id="tab-examonline">
        <h3>🎓 آزمون آنلاین</h3>
        <p class="muted">دانش‌آموزان، طراحی سوالات، و تصحیح و پاسخنامه‌ها — همه در یک‌جا</p>
        <div class="subtabs" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;border-bottom:2px solid #e2e8f0;padding-bottom:12px">
          <div class="subtab active" data-subtab="students">👨‍🎓 دانش‌آموزان</div>
          <div class="subtab" data-subtab="questions">📝 طراحی سوالات</div>
          <div class="subtab" data-subtab="answers">✅ تصحیح و پاسخنامه‌ها</div>
          <div class="subtab" data-subtab="worksheet">📓 کاربرگ</div>
        </div>

      <div class="subtab-content" id="tab-students">
        <h3>👨‍🎓 ساخت دانش‌آموز جدید</h3>
        <div class="row" style="align-items:center">
          <input id="new-label" placeholder="نام دانش‌آموز (اختیاری)">
          <label class="btn sec sm" style="flex:0 0 auto;cursor:pointer">📷 عکس پروفایل<input type="file" accept="image/*" id="new-student-photo" style="display:none"></label>
          <img id="new-student-photo-preview" class="hidden" style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex:0 0 auto">
          <button class="btn" id="btn-add-student" style="flex:0 0 auto">➕ ساخت لینک اختصاصی</button>
        </div>
        <p class="muted">برای هر دانش‌آموز یک UUID و لینک جداگانه ساخته می‌شود. عکس پروفایل اختیاری است (حداکثر ۲ مگابایت).</p>
        <div id="students-list"></div>
      </div>

      <div class="subtab-content hidden" id="tab-questions">
        <h3>📝 سربرگ آزمون</h3>
        <div class="row">
          <div><label>🏫 نام مدرسه</label><input id="m-school" placeholder="نام مدرسه"></div>
          <div><label>👨‍🏫 نام آموزگار</label><input id="m-teacher" placeholder="نام آموزگار"></div>
        </div>
        <div class="row">
          <div><label>📝 نام آزمون</label><input id="m-exam-name" placeholder="نام آزمون"></div>
          <div><label>🎓 مقطع تحصیلی</label>
            <select id="m-grade-level">
              <option value="elementary">ابتدایی (توصیفی)</option>
              <option value="middle">متوسطه اول (نمره‌ای)</option>
              <option value="high">متوسطه دوم (نمره‌ای)</option>
            </select>
            <span class="muted" style="font-size:12px">نوع ارزیابی: ابتدایی توصیفی، متوسطه نمره‌ای</span>
          </div>
        </div>
        <div class="row">
          <div><label>⏱️ مدت زمان (دقیقه)</label>
            <input id="m-exam-duration" type="number" min="1" max="180" value="30">
            <span class="muted" style="font-size:12px">مدت زمان آزمون به دقیقه</span>
          </div>
        </div>
        <div id="exam-time-status-display" class="exam-time-status valid">
          <span class="time-icon">⏱️</span>
          <span>مدت زمان: <span id="duration-display">30</span> دقیقه</span>
        </div>
        <hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
        <h3>📋 سوالات</h3>
        <div id="q-list"></div>
        <div class="row" style="margin-top:12px">
          <button class="btn gray sm" data-add="descriptive" style="flex:0 0 auto">➕ تشریحی</button>
          <button class="btn gray sm" data-add="multiple" style="flex:0 0 auto">➕ چهارگزینه‌ای</button>
          <button class="btn gray sm" data-add="truefalse" style="flex:0 0 auto">➕ صحیح/غلط</button>
          <button class="btn gray sm" data-add="short" style="flex:0 0 auto">➕ کوتاه‌پاسخ</button>
          <button class="btn sec sm" onclick="distributeWeights()" style="flex:0 0 auto">⚖️ تقسیم مساوی وزن‌ها</button>
        </div>
        <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" id="btn-save-q">💾 ذخیره سربرگ و سوالات</button>
          <a class="btn sec" id="btn-word-exam" href="/api/teacher/word?type=questions">📄 دانلود برگه آزمون (Word)</a>
        </div>
      </div>

      <div class="subtab-content hidden" id="tab-answers">
        <h3>✅ تصحیح و پاسخنامه‌ها</h3>
        <div class="grading-type-selector" style="margin-bottom:16px;padding:12px;background:#f0f9ff;border-radius:8px;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="radio" name="grading-type" value="descriptive" checked style="width:auto">
            <span>📝 تصحیح توصیفی (ابتدایی)</span>
          </label>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:8px">
            <input type="radio" name="grading-type" value="numeric" style="width:auto">
            <span>🔢 تصحیح نمره‌ای (متوسطه اول و دوم)</span>
          </label>
        </div>
        <div class="row" style="align-items:center;flex-wrap:wrap;gap:10px">
          <div style="flex:1;min-width:220px">
            <label>👤 انتخاب دانش‌آموز</label>
            <select id="ans-student-select"><option value="">— یک دانش‌آموز را انتخاب کنید —</option></select>
          </div>
          <button class="btn gray sm" id="btn-refresh-ans" style="flex:0 0 auto;margin-top:20px">🔄 به‌روزرسانی</button>
        </div>
        <div id="answers-list" style="margin-top:14px"></div>
      </div>

      <div class="subtab-content hidden" id="tab-worksheet">
        <h3>📓 کاربرگ</h3>
        <p class="muted">برای هر دانش‌آموز یک کاربرگ (عکس یا PDF) بارگذاری کنید. دانش‌آموز پس از انجام کاربرگ، عکس آن را برای شما ارسال می‌کند و شما می‌توانید زیر آن بازخورد بنویسید.</p>
        <div class="row" style="align-items:center;flex-wrap:wrap;gap:10px">
          <div style="flex:1;min-width:220px">
            <label>👤 انتخاب دانش‌آموز</label>
            <select id="ws-student-select"><option value="">— یک دانش‌آموز را انتخاب کنید —</option></select>
          </div>
          <button class="btn gray sm" id="btn-refresh-ws" style="flex:0 0 auto;margin-top:20px">🔄 به‌روزرسانی</button>
        </div>
        <div id="worksheet-list" style="margin-top:14px"></div>
      </div>

      </div>

      <div id="ans-photo-modal" class="mt-modal-overlay hidden" onclick="if(event.target===this)closeAnsPhoto()">
        <div style="max-width:95vw;max-height:90vh;position:relative">
          <button class="btn sm gray" style="position:absolute;top:-40px;left:0" onclick="closeAnsPhoto()">✖ بستن</button>
          <img id="ans-photo-modal-img" src="" style="max-width:95vw;max-height:85vh;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.4)">
          <div style="text-align:center;margin-top:10px">
            <a id="ans-photo-modal-dl" href="" download="پاسخ.jpg" class="btn primary">⬇️ دانلود عکس</a>
          </div>
        </div>
      </div>

      <div id="mt-modal-overlay" class="mt-modal-overlay hidden">
        <div class="mt-modal">
          <div class="mt-modal-head">
            <b>🧮 فرمول‌ساز ریاضی</b>
            <button type="button" class="btn sm gray" onclick="closeMathBuilder()">✖ بستن</button>
          </div>
          <div class="mt-palette">
            <span class="grp-label">قالب‌ها:</span>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertFrac()">کسر <span style="font-size:11px">a/b</span></button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertPow()">توان xⁿ</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertSub()">زیرنویس xₙ</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertRoot()">رادیکال ⁿ√</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertBigOp('\u2211')">جمع ∑</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertBigOp('\u220f')">حاصل‌ضرب ∏</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertBigOp('\u222b')">انتگرال ∫</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertLim()">حد lim</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertMatrix(2)">ماتریس ۲×۲</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertMatrix(3)">ماتریس ۳×۳</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertParen('(',')')">پرانتز ( )</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertParen('[',']')">کروشه [ ]</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertParen('{','}')">آکولاد { }</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertDiv()">تقسیم چکشی</button>
          </div>
          <div class="mt-palette">
            <span class="grp-label">علائم:</span>
            <span id="mt-sym-row"></span>
          </div>
          <p class="muted" style="margin:4px 0">روی هر جای فرمول کلیک کنید تا نشانگر آنجا برود، سپس قالب بعدی را از بالا اضافه کنید (امکان تودرتو کردن قالب‌ها وجود دارد). اعداد به‌صورت خودکار فارسی نوشته می‌شوند.</p>
          <div id="mt-canvas" class="mt-canvas rich" contenteditable="true" dir="rtl"></div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" onclick="mtInsertIntoQuestion()">➕ درج در سوال</button>
            <button class="btn gray" onclick="document.getElementById('mt-canvas').innerHTML=''">🗑️ پاک کردن فرمول</button>
          </div>
        </div>
      </div>

      <div class="card tab-content hidden" id="tab-examsheet">
        <h3 id="es-page-title">🖨️ ساخت آزمون (برگه چاپی)</h3>
        <p class="muted" id="es-page-desc">دقیقاً مثل برگه رسمی آزمون: سربرگ، مشخصات دانش‌آموز و جدول ردیف/سؤال/بارم. سؤال‌ها را اضافه کنید، ذخیره کنید و در پایان چاپ یا دانلود بگیرید.</p>

        <div id="es-print-area">
          <table class="es-header-table">
            <tr>
              <td><span>نام و نام‌خانوادگی:</span><input class="es-blank"></td>
              <td class="es-hdr-org"><input id="es-org1" placeholder="وزارت آموزش و پرورش جمهوری اسلامی ایران" value="وزارت آموزش و پرورش جمهوری اسلامی ایران"></td>
              <td><span>تاریخ آزمون:</span><input id="es-date"></td>
            </tr>
            <tr>
              <td><span>نام پدر:</span><input class="es-blank"></td>
              <td class="es-hdr-org"><input id="es-org2" placeholder="آموزش و پرورش ناحیه / منطقه ..."></td>
              <td><span>زمان آزمون:</span><input id="es-time"></td>
            </tr>
            <tr>
              <td><span>رشته / پایه:</span><input id="es-grade" placeholder="مثال: دهم انسانی"></td>
              <td><span>سال تحصیلی:</span><input id="es-schoolyear" placeholder="مثال: 1404-1403"></td>
              <td>
                <select id="es-examtitle">
                  <option value="آزمون نوبت اول">آزمون نوبت اول</option>
                  <option value="آزمون نوبت دوم">آزمون نوبت دوم</option>
                  <option value="ارزشیابی">ارزشیابی</option>
                </select>
                <input id="es-examtitle-extra" placeholder="توضیح تکمیلی" style="margin-top:3px">
              </td>
            </tr>
          </table>

          <table class="es-header-table" style="margin-top:6px">
            <tr>
              <td><span>نام درس:</span><input id="es-course" placeholder="نام درس"></td>
              <td>
                <select id="es-teacher-label" style="width:auto;flex:0 0 auto;font-weight:700;font-size:12.5px">
                  <option value="نام دبیر">نام دبیر:</option>
                  <option value="نام آموزگار">نام آموزگار:</option>
                </select>
                <input id="es-teacher" placeholder="نام">
              </td>
            </tr>
          </table>

          <table class="es-main-table" id="es-main-table">
            <thead><tr>
              <th class="es-col-num">ردیف</th><th>سؤال</th>
              <th class="es-col-mark">
                <select id="es-mark-label">
                  <option value="بارم">بارم</option>
                  <option value="بازخورد معلم">بازخورد معلم</option>
                </select>
              </th>
            </tr></thead>
            <tbody id="es-rows"></tbody>
          </table>

          <div class="es-pagefoot">صفحه ۱</div>
        </div>

        <div class="row" style="margin-top:16px;align-items:center">
          <button class="btn" id="btn-es-addrow">➕ افزودن سؤال</button>
          <button class="btn success" id="btn-es-save">💾 ذخیره</button>
          <button class="btn sec" id="btn-es-word">📄 دانلود Word</button>
          <button class="btn gray" id="btn-es-pdf">📕 دانلود PDF</button>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600">🔤 اندازه فونت:
            <input type="number" id="es-font-size" min="8" max="36" step="1" value="12" style="width:60px;padding:6px;border:1px solid #ddd;border-radius:6px">
          </label>
        </div>
      </div>

      <div class="card tab-content hidden" id="tab-schedule">
        <h3>📅 برنامه هفتگی</h3>
        <div class="row" style="margin-bottom:16px;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="font-weight:700">🎨 تم رنگی:</span>
          <button class="btn sm sch-theme-btn active" data-theme="default">🌈 پیش‌فرض</button>
          <button class="btn sm sch-theme-btn" data-theme="boy">💙 پسرانه</button>
          <button class="btn sm sch-theme-btn" data-theme="girl">💗 دخترانه</button>
        </div>
        <div class="row" style="margin-bottom:16px">
          <input id="sch-school" placeholder="نام مدرسه" style="flex:1">
          <input id="sch-year" placeholder="سال تحصیلی" style="flex:1">
        </div>
        <div class="row" style="margin-bottom:16px">
          <input id="sch-topic" placeholder="موضوع" style="flex:1">
          <input id="sch-principal" placeholder="نام مدیر" style="flex:1">
        </div>
        <div class="row" style="margin-bottom:16px">
          <input id="sch-class" placeholder="نام کلاس" style="flex:1">
          <input id="sch-teacher" placeholder="نام آموزگار" style="flex:1">
        </div>
        <div class="schedule-table-wrap" id="schedule-table-wrap">
          <table class="schedule-table" id="schedule-table">
            <thead><tr><th class="sch-corner">روز / زنگ</th><th class="sch-period">🔔 زنگ اول</th><th class="sch-period">🔔 زنگ دوم</th><th class="sch-period">🔔 زنگ سوم</th><th class="sch-period">🔔 زنگ چهارم</th><th class="sch-period">🔔 زنگ پنجم</th></tr></thead>
            <tbody id="schedule-body"></tbody>
          </table>
        </div>
        <button class="btn primary" id="btn-gen-schedule">🔄 ساخت جدول</button>
        <button class="btn" id="btn-print-schedule">🖨️ چاپ</button>
        <button class="btn sec" id="btn-word-schedule">📄 دانلود Word</button>
        <button class="btn gray" id="btn-pdf-schedule">📕 دانلود PDF</button>
        <button class="btn" id="btn-save-schedule">💾 ذخیره در سرور</button>
      </div>

      <div class="card tab-content hidden" id="tab-tablesorg">
        <h3>📊 جدول‌ساز</h3>
        <div class="subtabs" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;border-bottom:2px solid #e2e8f0;padding-bottom:12px">
          <div class="subtab active" data-subtab="tables">📊 جدول‌ساز حرفه‌ای</div>
          <div class="subtab" data-subtab="orgform">🏫 سازمان عملی</div>
        </div>

      <div class="subtab-content" id="tab-tables">
        <h3>📊 جدول‌ساز حرفه‌ای</h3>
        <div class="row" style="margin-bottom:16px">
          <div><label style="display:block;margin-bottom:4px">تعداد سطر:</label><input type="number" id="tbl-rows" value="5" min="1" max="50" style="width:100px;padding:8px;border:1px solid #ddd;border-radius:6px"></div>
          <div><label style="display:block;margin-bottom:4px">تعداد ستون:</label><input type="number" id="tbl-cols" value="4" min="1" max="20" style="width:100px;padding:8px;border:1px solid #ddd;border-radius:6px"></div>
          <div><label style="display:block;margin-bottom:4px">عنوان جدول:</label><input type="text" id="tbl-title" placeholder="مثال: لیست نمرات" style="width:200px;padding:8px;border:1px solid #ddd;border-radius:6px"></div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer">
          <input type="checkbox" id="tbl-avg-check" checked>
          <span>📈 محاسبه خودکار میانگین (ستون‌های عددی) — به‌صورت زنده و با فرمول واقعی اکسل</span>
        </label>
        <div class="row" style="margin-bottom:12px">
          <input type="file" id="tbl-pdf-file" accept="application/pdf" class="hidden">
          <button class="btn secondary" id="btn-tbl-import-pdf">📥 وارد کردن جدول از PDF</button>
          <span class="muted" id="tbl-pdf-status"></span>
        </div>
        <div class="xls-wrap">
          <div class="xls-scroll">
            <table class="xls-grid" id="custom-table">
              <thead id="custom-table-head"></thead>
              <tbody id="custom-table-body"></tbody>
              <tfoot id="custom-table-foot"></tfoot>
            </table>
          </div>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="btn-gen-table">🔄 ساخت جدول</button>
          <button class="btn sec" id="btn-tbl-add-row">➕ افزودن ردیف</button>
          <button class="btn success" id="btn-save-table">💾 ذخیره</button>
          <button class="btn sec" id="btn-word-table">📄 دانلود Word</button>
          <button class="btn gray" id="btn-excel-table">📊 دانلود Excel واقعی (xlsx)</button>
        </div>
        <p class="muted" style="margin-top:6px">نکته: زدن دوباره‌ی «ساخت جدول» کل جدول را از نو می‌سازد و اطلاعات فعلی پاک می‌شود؛ برای افزودن سطر بدون پاک‌شدن اطلاعات، از دکمه‌ی «افزودن ردیف» استفاده کنید. برای حذف یک ستون، روی دکمه‌ی ✖ کنار عنوان همان ستون بزنید.</p>
      </div>

      <div class="subtab-content hidden" id="tab-orgform">
        <h3>🏫 فرم سازمان عملی</h3>
        <p class="muted">اطلاعات را همین‌جا پر کنید؛ در پایان با یک کلیک فایل اکسل رسمی (با فرمول، دراپ‌داون و هدر ثابت) دقیقاً با همین اطلاعات ساخته می‌شود.</p>

        <h4 style="margin-top:20px">۱) مشخصات آموزشگاه</h4>
        <div class="org-field-grid">
          <div class="org-field"><label>سال تحصیلی</label><input type="text" id="org-year" placeholder="مثال: 1404-1405"></div>
          <div class="org-field"><label>فرم شماره</label><input type="text" id="org-formno"></div>
          <div class="org-field"><label>منطقه</label><input type="text" id="org-region"></div>
          <div class="org-field"><label>نام آموزشگاه</label><input type="text" id="org-school"></div>
          <div class="org-field"><label>کد آموزشگاه</label><input type="text" id="org-schoolcode"></div>
          <div class="org-field"><label>نام مدیر</label><input type="text" id="org-principal"></div>
          <div class="org-field"><label>جنسیت</label><select id="org-gender"><option value=""></option><option>پسر</option><option>دختر</option><option>مختلط</option></select></div>
          <div class="org-field"><label>مقطع</label><input type="text" id="org-level"></div>
          <div class="org-field"><label>کد فضا</label><input type="text" id="org-spacecode"></div>
          <div class="org-field"><label>نوع اداره</label><select id="org-adminType"><option value=""></option><option>دولتی</option><option>غیردولتی</option></select></div>
          <div class="org-field"><label>وضعیت ساختمان</label><select id="org-buildingStatus"><option value=""></option><option>ملکی</option><option>استیجاری</option><option>سایر</option></select></div>
          <div class="org-field"><label>وضعیت</label><select id="org-status"><option value=""></option><option>فعال</option><option>غیرفعال</option></select></div>
          <div class="org-field"><label>نوع ساختمان</label><select id="org-buildingType"><option value=""></option><option>آجری</option><option>بتنی</option><option>سایر</option></select></div>
          <div class="org-field"><label>شماره تلفن</label><input type="text" id="org-phone"></div>
        </div>
        <div class="org-field" style="margin-top:10px"><label>نشانی آموزشگاه</label><input type="text" id="org-address" style="width:100%"></div>

        <h4 style="margin-top:24px">۲) آمار کلاس‌ها و دانش‌آموزان به تفکیک پایه</h4>
        <div class="xls-wrap">
          <div class="xls-scroll">
            <table class="xls-grid" id="org-stat-table">
              <thead>
                <tr><th rowspan="2">پایه</th><th colspan="4">کلاس</th><th colspan="3">دانش‌آموزان</th></tr>
                <tr><th>پسرانه</th><th>دخترانه</th><th>مختلط</th><th>جمع</th><th>پسر</th><th>دختر</th><th>جمع</th></tr>
              </thead>
              <tbody id="org-stat-body"></tbody>
              <tfoot id="org-stat-foot"></tfoot>
            </table>
          </div>
        </div>

        <h4 style="margin-top:24px">تعداد دانش‌آموزان خاص</h4>
        <table class="xls-grid" id="org-special-table" style="max-width:420px">
          <tbody id="org-special-body"></tbody>
        </table>

        <h4 style="margin-top:24px">۳) اطلاعات پرسنل</h4>
        <div class="xls-wrap">
          <div class="xls-scroll">
            <table class="xls-grid" id="org-staff-table">
              <thead><tr><th>ردیف</th><th>کد پرسنلی</th><th>نام</th><th>نام خانوادگی</th><th>کد ملی</th><th>مدرک</th><th>رشته تحصیلی</th><th>سابقه</th><th>نوع استخدام / وضعیت</th><th>پست سازمانی</th><th>آدرس</th><th>تلفن</th><th>حذف</th></tr></thead>
              <tbody id="org-staff-body"></tbody>
            </table>
          </div>
        </div>
        <button class="btn sm secondary" id="btn-org-staff-addrow" style="margin-top:8px">➕ افزودن ردیف</button>

        <h4 style="margin-top:24px">۴) ساعات موظف / غیرموظف معلمان به تفکیک پایه</h4>
        <p class="muted">می‌توانید اسامی و کد پرسنلی را از یک ستون کپی و در اولین خانه پیست کنید (مثل بقیه جدول‌های برنامه).</p>
        <div class="xls-wrap">
          <div class="xls-scroll">
            <table class="xls-grid" id="org-hours-table">
              <thead>
                <tr><th rowspan="2">ردیف</th><th rowspan="2">کد پرسنلی</th><th rowspan="2">نام و نام خانوادگی</th><th colspan="3">پایه اول</th><th colspan="3">پایه دوم</th><th colspan="3">پایه سوم</th><th colspan="3">پایه چهارم</th><th colspan="3">پایه پنجم</th><th colspan="3">پایه ششم</th><th colspan="3">چندپایه</th><th colspan="3">جمع</th><th rowspan="2">حذف</th></tr>
                <tr><th>موظف</th><th>غ‌موظف</th><th>جمع</th><th>موظف</th><th>غ‌موظف</th><th>جمع</th><th>موظف</th><th>غ‌موظف</th><th>جمع</th><th>موظف</th><th>غ‌موظف</th><th>جمع</th><th>موظف</th><th>غ‌موظف</th><th>جمع</th><th>موظف</th><th>غ‌موظف</th><th>جمع</th><th>موظف</th><th>غ‌موظف</th><th>جمع</th><th>موظف</th><th>غ‌موظف</th><th>جمع</th></tr>
              </thead>
              <tbody id="org-hours-body"></tbody>
            </table>
          </div>
        </div>
        <button class="btn sm secondary" id="btn-org-hours-addrow" style="margin-top:8px">➕ افزودن ردیف</button>

        <div class="row" style="margin-top:20px">
          <button class="btn success" id="btn-org-save">💾 ذخیره</button>
          <button class="btn primary" id="btn-org-form">📥 ساخت و دانلود فرم سازمان عملی</button>
          <button class="btn secondary" id="btn-org-print">🖨️ چاپ</button>
        </div>
      </div>

      </div>

      <div class="card tab-content hidden" id="tab-imgtools">
        <h3>🖼️ ابزار عکس</h3>
        <p class="muted">اسکنر، کاهش حجم، برش و تبدیل PDF به عکس — همه در یک‌جا</p>
        <div class="subtabs" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;border-bottom:2px solid #e2e8f0;padding-bottom:12px">
          <div class="subtab active" data-subtab="scan">📷 اسکنر</div>
          <div class="subtab" data-subtab="resize">🗜️ کاهش حجم</div>
          <div class="subtab" data-subtab="crop">✂️ برش عکس</div>
          <div class="subtab" data-subtab="pdf2img">📄 PDF به عکس</div>
          <div class="subtab" data-subtab="pdf2word">📝 PDF به Word</div>
        </div>

      <div class="subtab-content" id="tab-scan">
        <h3>📷 اسکنر حرفه‌ای (مشابه CamScanner)</h3>
        <p class="muted">عکس‌های خود را با کیفیت بالا اسکن کنید</p>
        <div class="upload-zone" id="scan-drop-zone">
          <input type="file" accept="image/*" id="scan-file" class="hidden">
          <div class="upload-icon">📷</div>
          <p>عکس را اینجا رها کنید یا کلیک کنید</p>
          <span class="muted">فرمت‌های مجاز: JPG, PNG, WEBP</span>
        </div>
        <div id="scan-warp-stage" class="hidden">
          <div id="scan-warp-wrapper" style="position:relative;max-width:100%;display:inline-block;touch-action:none;user-select:none">
            <img id="scan-warp-img" src="" style="width:100%;max-width:500px;display:block;border-radius:8px" draggable="false">
            <svg id="scan-warp-svg" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none">
              <polygon id="scan-warp-poly" points="" style="fill:rgba(102,126,234,0.25);stroke:#667eea;stroke-width:2"></polygon>
            </svg>
            <div class="scan-warp-handle" data-corner="tl" style="position:absolute;width:26px;height:26px;margin:-13px;border-radius:50%;background:#667eea;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);cursor:grab;touch-action:none"></div>
            <div class="scan-warp-handle" data-corner="tr" style="position:absolute;width:26px;height:26px;margin:-13px;border-radius:50%;background:#667eea;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);cursor:grab;touch-action:none"></div>
            <div class="scan-warp-handle" data-corner="br" style="position:absolute;width:26px;height:26px;margin:-13px;border-radius:50%;background:#667eea;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);cursor:grab;touch-action:none"></div>
            <div class="scan-warp-handle" data-corner="bl" style="position:absolute;width:26px;height:26px;margin:-13px;border-radius:50%;background:#667eea;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);cursor:grab;touch-action:none"></div>
          </div>
          <p class="muted" style="margin-top:8px">۴ گوشهٔ آبی رو دقیقاً روی ۴ گوشهٔ سند بکشید تا بعد از برش، سند کاملاً صاف و بدون کجی دربیاد.</p>
          <div class="scan-toolbar">
            <button class="btn secondary" id="btn-scan-autodetect">🔍 تشخیص خودکار لبه‌ها</button>
            <button class="btn primary" id="btn-scan-warp-apply">✅ برش و صاف‌کردن سند</button>
            <button class="btn gray" id="btn-scan-warp-skip">➡️ رد شدن (بدون برش)</button>
          </div>
        </div>
        <div id="scan-controls" class="hidden">
          <div class="filter-presets">
            <button class="filter-btn active" data-filter="original">اصلی</button>
            <button class="filter-btn" data-filter="color">رنگی</button>
            <button class="filter-btn" data-filter="gray">خاکستری</button>
            <button class="filter-btn" data-filter="bw">سیاه/سفید</button>
            <button class="filter-btn" data-filter="document">سند</button>
            <button class="filter-btn" data-filter="enhance">بهبود</button>
            <button class="filter-btn" data-filter="textoenhance">📝 تقویت متن</button>
            <button class="filter-btn" data-filter="removeshadow">🌫️ حذف سایه</button>
            <button class="filter-btn" data-filter="whitenbg">🧹 سفید کردن پس‌زمینه</button>
          </div>
          <div class="scan-settings">
            <div class="setting-group"><label>🔆 روشنایی</label><input type="range" id="scan-bright" min="-100" max="100" value="0"><span class="setting-value" id="bright-val">0</span></div>
            <div class="setting-group"><label>◐ کنتراست</label><input type="range" id="scan-contrast" min="-50" max="50" value="0"><span class="setting-value" id="contrast-val">0</span></div>
            <div class="setting-group"><label>🎯 وضوح</label><input type="range" id="scan-sharp" min="0" max="100" value="0"><span class="setting-value" id="sharp-val">0</span></div>
            <div class="setting-group"><label>🔵 اشباع رنگ</label><input type="range" id="scan-saturation" min="-100" max="100" value="0"><span class="setting-value" id="saturation-val">0</span></div>
          </div>
          <div class="scan-preview"><canvas id="scan-canvas"></canvas></div>
          <div class="scan-toolbar">
            <button class="btn secondary" id="btn-rescan-warp">🔲 برش مجدد سند</button>
            <button class="btn secondary" id="btn-rotate-l">↶ چرخش چپ</button>
            <button class="btn secondary" id="btn-rotate-r">↷ چرخش راست</button>
            <button class="btn secondary" id="btn-scan-autoenhance">✨ روشن‌سازی خودکار</button>
            <div class="setting-group" style="display:inline-flex;align-items:center;gap:6px;margin:0 8px"><label style="margin:0">📦 کیفیت خروجی</label><input type="range" id="scan-out-quality" min="30" max="100" value="90" style="width:100px"><span class="setting-value" id="scan-out-quality-val">90%</span></div>
            <button class="btn primary" id="btn-dl-img">💾 دانلود عکس</button>
            <button class="btn success" id="btn-dl-pdf">📄 دانلود PDF</button>
            <button class="btn secondary" id="btn-reset-scan">🔄 بازنشانی فیلترها</button>
            <button class="btn danger" id="btn-remove-scan">🗑️ حذف عکس</button>
          </div>
        </div>
      </div>

      <div class="subtab-content hidden" id="tab-resize">
        <h3>🗜️ کاهش حجم عکس</h3>
        <p class="muted">عکس‌ها را با کیفیت دلخواه فشرده کنید</p>
        <div class="upload-zone" id="resize-drop-zone">
          <input type="file" accept="image/*" id="resize-file" class="hidden" multiple>
          <div class="upload-icon">🖼️</div>
          <p>عکس را اینجا رها کنید یا کلیک کنید</p>
          <span class="muted">می‌توانید چند عکس انتخاب کنید</span>
        </div>
        <div id="resize-controls" class="hidden">
          <div class="resize-options">
            <div class="resize-group"><label>📊 کیفیت تصویر</label><input type="range" id="resize-quality" min="10" max="100" value="85"><div class="quality-display"><span id="quality-percent">85%</span><span class="muted" id="quality-estimate">حدود 500 کیلوبایت</span></div></div>
            <div class="resize-group"><label>📏 اندازه خروجی</label><div class="size-options"><label class="size-option"><input type="radio" name="resize-size" value="original" checked> حفظ اندازه اصلی</label><label class="size-option"><input type="radio" name="resize-size" value="1920"> 1920px (بزرگ)</label><label class="size-option"><input type="radio" name="resize-size" value="1280"> 1280px (متوسط)</label><label class="size-option"><input type="radio" name="resize-size" value="800"> 800px (کوچک)</label></div></div>
            <div class="resize-group"><label>📐 فرمت خروجی</label><div class="format-options"><button class="format-btn active" data-format="jpeg">JPEG</button><button class="format-btn" data-format="png">PNG</button><button class="format-btn" data-format="webp">WEBP</button></div></div>
            <div class="resize-group" id="resize-total-info" style="background:#e0f2fe;border:2px solid #93c5fd"><label>📦 اطلاعات کلی</label><div style="display:flex;justify-content:space-between;margin-top:8px"><div><span class="muted">حجم اصلی:</span> <strong id="total-original-size">-</strong></div><div><span class="muted">حجم جدید:</span> <strong id="total-new-size" style="color:#10b981">-</strong></div><div><span class="muted">کاهش:</span> <strong id="total-reduction" style="color:#059669">-</strong></div></div></div>
          </div>
          <div class="resize-preview" id="resize-preview"></div>
          <div class="resize-toolbar"><button class="btn primary" id="btn-resize-all">⚡ فشرده‌سازی همه (دانلود جداگانه)</button><button class="btn sec" id="btn-resize-zip">📦 دانلود همه به‌صورت ZIP</button><button class="btn secondary" id="btn-clear-resize">🗑️ پاک کردن</button></div>
        </div>
      </div>

      <div class="subtab-content hidden" id="tab-crop">
        <h3>✂️ برش عکس</h3>
        <p class="muted">عکس‌های خود را برش بزنید و دانلود کنید (قابل استفاده در گوشی و کامپیوتر)</p>
        <div class="upload-zone" id="crop-drop-zone">
          <input type="file" accept="image/*" id="crop-file" class="hidden">
          <div class="upload-icon">🖼️</div>
          <p>عکس را اینجا رها کنید یا کلیک کنید</p>
          <span class="muted">یک عکس برای برش انتخاب کنید</span>
        </div>
        <div id="crop-controls" class="hidden">
          <div class="crop-area"><div id="crop-wrapper"><img id="crop-img" src="" alt="برش"><div id="crop-box"><div class="crop-handle crop-nw"></div><div class="crop-handle crop-n"></div><div class="crop-handle crop-ne"></div><div class="crop-handle crop-w"></div><div class="crop-handle crop-e"></div><div class="crop-handle crop-sw"></div><div class="crop-handle crop-s"></div><div class="crop-handle crop-se"></div></div></div></div>
          <div class="crop-options">
            <div class="crop-ratios">
              <span>نسبت تصویر:</span>
              <button class="ratio-btn active" data-ratio="free">آزاد</button>
              <button class="ratio-btn" data-ratio="1:1">۱:۱ (مربع)</button>
              <button class="ratio-btn" data-ratio="4:3">۴:۳</button>
              <button class="ratio-btn" data-ratio="3:4">۳:۴ (عمودی)</button>
              <button class="ratio-btn" data-ratio="16:9">۱۶:۹ (عریض)</button>
              <button class="ratio-btn" data-ratio="210:297">A4 (عمودی)</button>
            </div>
          </div>
          <div class="crop-actions"><button class="btn danger" id="btn-crop-delete">🗑️ حذف عکس</button><button class="btn secondary" id="btn-crop-reset">↩️ بازنشانی</button><button class="btn primary" id="btn-crop-download">💾 دانلود عکس</button></div>
        </div>
      </div>

      <div class="subtab-content hidden" id="tab-pdf2img">
        <h3>📄 تبدیل PDF به عکس</h3>
        <p class="muted">صفحات PDF را به تصاویر با کیفیت تبدیل کنید</p>
        <div class="upload-zone" id="pdf-drop-zone">
          <input type="file" accept="application/pdf" id="pdf-file" class="hidden">
          <div class="upload-icon">📄</div>
          <p>فایل PDF را اینجا رها کنید یا کلیک کنید</p>
          <span class="muted">فایل PDF برای تبدیل انتخاب کنید</span>
        </div>
        <div id="pdf-controls" class="hidden">
          <div class="pdf-info" style="margin-bottom:16px;padding:12px;background:#f0f9ff;border-radius:8px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div><strong id="pdf-name">فایل PDF</strong><span class="muted" style="margin-right:12px">تعداد صفحات: <strong id="pdf-pages-count">0</strong></span></div>
              <button class="btn sm danger" id="pdf-remove">🗑️ حذف</button>
            </div>
          </div>
          <div class="pdf-options" style="margin-bottom:16px">
            <div class="pdf-option-group"><label>انتخاب صفحات:</label><div class="pdf-page-select"><button class="pdf-select-btn active" data-pages="all">همه صفحات</button><button class="pdf-select-btn" data-pages="odd">صفحات فرد</button><button class="pdf-select-btn" data-pages="even">صفحات زوج</button><button class="pdf-select-btn" data-pages="range">محدوده</button></div><input type="text" id="pdf-range" placeholder="مثال: 1,3,5-10" style="margin-top:8px" class="hidden"></div>
            <div class="pdf-option-group" style="margin-top:12px"><label>DPI (کیفیت تصویر):</label><div class="pdf-dpi-select"><button class="pdf-dpi-btn" data-dpi="72">72 DPI<small>پیش‌نمایش</small></button><button class="pdf-dpi-btn active" data-dpi="150">150 DPI<small>متوسط</small></button><button class="pdf-dpi-btn" data-dpi="300">300 DPI<small>بالا</small></button></div></div>
            <div class="pdf-option-group" style="margin-top:12px"><label>🔄 چرخش تصویر:</label><div class="pdf-rotate-select"><button class="btn sm secondary" id="btn-pdf-rotate-l">↶ چرخش چپ</button><button class="btn sm secondary" id="btn-pdf-rotate-r">↷ چرخش راست</button><span class="muted" style="margin-right:8px">زاویهٔ فعلی: <strong id="pdf-rotate-val">۰</strong> درجه</span></div></div>
            <div class="pdf-option-group" style="margin-top:12px"><label>فرمت خروجی:</label><div class="pdf-format-select"><button class="pdf-format-btn" data-format="png">PNG</button><button class="pdf-format-btn active" data-format="jpeg">JPEG</button></div><div id="jpeg-quality-group" style="margin-top:8px"><label>📦 کیفیت خروجی:</label><input type="range" id="jpeg-quality" min="50" max="100" value="85" style="width:150px"><span id="jpeg-quality-val">85%</span></div></div>
          </div>
          <div class="pdf-preview" id="pdf-preview" style="margin-bottom:16px"></div>
          <div class="pdf-toolbar"><button class="btn primary" id="btn-pdf-render-all">⚡ رندر همه صفحات</button><button class="btn secondary" id="btn-pdf-download-zip">📦 دانلود ZIP</button><button class="btn gray" id="btn-pdf-clear-previews">🗑️ پاک کردن پیش‌نمایش‌ها</button></div>
        </div>
      </div>

      <div class="subtab-content hidden" id="tab-pdf2word">
        <h3>📝 تبدیل PDF به Word (قابل ویرایش)</h3>
        <p class="muted">متن PDF استخراج و در قالب یک فایل Word قابل‌ویرایش (.doc) قرار می‌گیرد. توجه: چون PDF ساختار متنی استاندارد ندارد، ممکن است چیدمان دقیق صفحه (جدول‌ها، ستون‌بندی، تصاویر) کاملاً حفظ نشود؛ اما متن به‌صورت کامل و قابل ویرایش استخراج می‌شود.</p>
        <div class="upload-zone" id="pdf2word-drop-zone">
          <input type="file" accept="application/pdf" id="pdf2word-file" class="hidden">
          <div class="upload-icon">📝</div>
          <p>فایل PDF را اینجا رها کنید یا کلیک کنید</p>
          <span class="muted">فایل PDF برای تبدیل به Word انتخاب کنید</span>
        </div>
        <div id="pdf2word-controls" class="hidden">
          <div class="pdf-info" style="margin-bottom:16px;padding:12px;background:#f0f9ff;border-radius:8px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div><strong id="pdf2word-name">فایل PDF</strong><span class="muted" style="margin-right:12px">تعداد صفحات: <strong id="pdf2word-pages-count">0</strong></span></div>
              <button class="btn sm danger" id="pdf2word-remove">🗑️ حذف</button>
            </div>
          </div>
          <div id="pdf2word-status" class="muted" style="margin-bottom:12px"></div>
          <div class="pdf-toolbar"><button class="btn primary" id="btn-pdf2word-convert">⚡ استخراج و ساخت Word</button><button class="btn success hidden" id="btn-pdf2word-download">💾 دانلود فایل Word</button></div>
        </div>
      </div>

      </div>

      <div class="card tab-content hidden" id="tab-translateai">
        <h3>🌐🤖 ترجمه و هوش مصنوعی</h3>
        <div class="subtabs" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;border-bottom:2px solid #e2e8f0;padding-bottom:12px">
          <div class="subtab active" data-subtab="translate">🌐 ترجمه</div>
          <div class="subtab" data-subtab="ai">🤖 هوش مصنوعی</div>
        </div>

      <div class="subtab-content" id="tab-translate">
        <h3>🌐 ترجمه متن (با هوش مصنوعی)</h3>
        <p class="muted">ترجمه‌ی حرفه‌ای و طبیعی بین زبان‌ها — با تشخیص خودکار زبان، انتخاب لحن، و بازبینی کیفیت ترجمه</p>
        <div class="tl-lang-row">
          <select id="tl-from">
            <option value="auto">🔍 تشخیص خودکار زبان</option>
            <option value="fa">فارسی</option>
            <option value="en">انگلیسی</option>
            <option value="ar">عربی</option>
            <option value="fr">فرانسوی</option>
            <option value="de">آلمانی</option>
            <option value="tr">ترکی استانبولی</option>
            <option value="es">اسپانیایی</option>
            <option value="it">ایتالیایی</option>
            <option value="pt">پرتغالی</option>
            <option value="ru">روسی</option>
            <option value="zh">چینی</option>
            <option value="ja">ژاپنی</option>
            <option value="ko">کره‌ای</option>
            <option value="ur">اردو</option>
            <option value="hi">هندی</option>
            <option value="ps">پشتو</option>
            <option value="ku">کردی (سورانی)</option>
            <option value="az">آذربایجانی</option>
            <option value="hy">ارمنی</option>
          </select>
          <button class="btn sm" onclick="tlSwap()" title="جابه‌جایی زبان مبدا و مقصد">⇄</button>
          <select id="tl-to">
            <option value="en">انگلیسی</option>
            <option value="fa">فارسی</option>
            <option value="ar">عربی</option>
            <option value="fr">فرانسوی</option>
            <option value="de">آلمانی</option>
            <option value="tr">ترکی استانبولی</option>
            <option value="es">اسپانیایی</option>
            <option value="it">ایتالیایی</option>
            <option value="pt">پرتغالی</option>
            <option value="ru">روسی</option>
            <option value="zh">چینی</option>
            <option value="ja">ژاپنی</option>
            <option value="ko">کره‌ای</option>
            <option value="ur">اردو</option>
            <option value="hi">هندی</option>
            <option value="ps">پشتو</option>
            <option value="ku">کردی (سورانی)</option>
            <option value="az">آذربایجانی</option>
            <option value="hy">ارمنی</option>
          </select>
          <select id="tl-tone" title="لحن ترجمه">
            <option value="neutral">🎯 لحن عادی</option>
            <option value="formal">🎩 رسمی / اداری</option>
            <option value="informal">💬 محاوره‌ای</option>
            <option value="academic">📘 علمی / آکادمیک</option>
            <option value="simple">🧒 ساده و روان (کودکانه)</option>
          </select>
        </div>
        <div style="margin-bottom:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="file" id="tl-img-file" accept="image/*" class="hidden">
          <input type="file" id="tl-pdf-file" accept="application/pdf" class="hidden">
          <button class="btn sm sec" id="btn-tl-from-img">📷 گرفتن متن از عکس</button>
          <button class="btn sm sec" id="btn-tl-from-pdf">📄 گرفتن متن از PDF</button>
          <span class="muted" id="tl-extract-status" style="font-size:12px"></span>
        </div>
        <div class="tl-grid">
          <div>
            <label>متن ورودی:</label>
            <textarea id="tl-input" rows="9" dir="rtl" placeholder="متن خود را اینجا بنویسید یا بچسبانید، یا از عکس/PDF بگیرید..."></textarea>
            <div class="muted" style="font-size:12px;margin-top:4px" id="tl-input-count">۰ کاراکتر</div>
          </div>
          <div>
            <label>ترجمه:</label>
            <textarea id="tl-output" rows="9" dir="ltr" readonly placeholder="ترجمه اینجا نمایش داده می‌شود..."></textarea>
            <div class="muted" style="font-size:12px;margin-top:4px" id="tl-output-count">۰ کاراکتر</div>
          </div>
        </div>
        <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn primary" id="btn-translate">🌐 ترجمه کن</button>
          <button class="btn sec" id="btn-translate-back">🔁 بازبینی (ترجمه معکوس)</button>
          <button class="btn" onclick="tlCopy()">📋 کپی ترجمه</button>
          <button class="btn gray" onclick="tlClear()">🗑️ پاک کردن</button>
        </div>
        <div id="tl-back-box" class="hidden" style="margin-top:14px;padding:12px 14px;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:10px">
          <div style="font-size:12px;font-weight:700;color:#475569;margin-bottom:6px">🔁 بازترجمه به زبان مبدا (برای بررسی صحت و طبیعی‌بودن ترجمه)</div>
          <div id="tl-back-text" style="font-size:14px;color:#334155"></div>
        </div>
        <p class="muted" style="font-size:12px;margin-top:10px">💡 نکته: اگر متن شامل اصطلاح تخصصی یا آموزشی خاصی است، آن را داخل پرانتز در متن ورودی توضیح بدهید تا ترجمه دقیق‌تر شود.</p>
      </div>

      <div class="subtab-content hidden" id="tab-ai">
        <div class="ai-chat-container">
          <div class="ai-header">
            <div class="ai-avatar">🤖</div>
            <div class="ai-title"><h3>دستیار هوش مصنوعی</h3><span class="ai-status">آنلاین</span></div>
            <button type="button" class="btn sm gray" id="btn-ai-clear" title="پاک کردن کل گفتگو" style="flex:0 0 auto;width:34px;height:34px;padding:0;border-radius:50%;display:flex;align-items:center;justify-content:center">🗑️</button>
          </div>
          <div id="ai-messages" class="ai-messages">
            <div class="ai-message ai"><div class="ai-message-avatar">🤖</div><div class="ai-message-content"><div class="ai-message-text">سلام! 👋 من دستیار هوش مصنوعی شما هستم. چطور می‌توانم کمکتان کنم؟</div></div></div>
          </div>
          <div class="ai-typing hidden" id="ai-typing">
            <div class="ai-message ai"><div class="ai-message-avatar">🤖</div><div class="ai-message-content"><div class="ai-typing-dots"><span></span><span></span><span></span></div></div></div>
          </div>
          <div id="ai-img-preview" class="hidden ai-attach-preview">
            <img id="ai-img-preview-thumb" style="width:36px;height:36px;object-fit:cover;border-radius:8px;flex:0 0 auto">
            <span>🖼️ تصویر ضمیمه شد</span>
            <button type="button" id="btn-ai-img-remove" class="ai-attach-remove" title="حذف تصویر">✕</button>
          </div>
          <div id="ai-pdf-preview" class="hidden ai-attach-preview">
            <span style="font-size:17px;flex:0 0 auto">📄</span>
            <span id="ai-pdf-preview-name">فایل PDF ضمیمه شد</span>
            <button type="button" id="btn-ai-pdf-remove" class="ai-attach-remove" title="حذف فایل">✕</button>
          </div>
          <div class="ai-input-area">
            <input type="file" id="ai-img-file" accept="image/*" class="hidden">
            <input type="file" id="ai-pdf-file" accept="application/pdf" class="hidden">
            <button type="button" class="btn gray ai-send-btn" id="btn-ai-img-pick" title="پیوست عکس">📷</button>
            <button type="button" class="btn gray ai-send-btn" id="btn-ai-pdf-pick" title="پیوست PDF">📄</button>
            <textarea id="ai-input" placeholder="پیام خود را بنویسید..." rows="1"></textarea>
            <button class="btn primary ai-send-btn" id="btn-ai-send"><span>➤</span></button>
          </div>
        </div>
      </div>

      </div>

      <div class="card tab-content hidden" id="tab-classroom">
        <h3>🖥️ کلاس آنلاین</h3>
        <div class="cls-status" style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span class="dot" id="tdot" style="width:10px;height:10px;border-radius:50%;background:#dc2626;display:inline-block;flex:0 0 auto"></span>
          <span id="t-cls-status" class="muted" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">کلاس آنلاین شروع نشده</span>
          <button type="button" class="btn sm sec" id="btn-cls-options-toggle" style="flex:0 0 auto">⚙️ گزینه‌ها</button>
        </div>
        <div id="cls-options-drawer" class="cls-options-drawer hidden">
          <button class="btn sm cls-opt-btn" id="btn-cls-start">▶️ شروع کلاس</button>
          <button class="btn sm gray hidden cls-opt-btn" id="btn-cls-stop">⏹️ پایان کلاس</button>
          <button class="btn sm sec hidden cls-opt-btn" id="btn-mic-toggle">🎙️ روشن کردن میکروفون</button>
          <button class="btn sm sec hidden cls-opt-btn" id="btn-cam-toggle">📷 روشن کردن تصویر</button>
          <button class="btn sm sec hidden cls-opt-btn" id="btn-cam-flip">🔄 چرخش دوربین</button>
        </div>
        <video id="t-cam-preview" autoplay muted playsinline class="hidden" style="width:160px;max-width:45vw;border-radius:10px;border:1px solid var(--line);margin-bottom:10px;background:#000"></video>

        <div class="cls-wrap" style="display:flex;gap:12px;flex-wrap:wrap">
          <div class="cls-board-col">
            <div class="cls-pdf-panel">
              <div class="row" style="align-items:center;flex-wrap:wrap">
                <label class="btn sm sec" style="cursor:pointer;flex:0 0 auto">📄 افزودن PDF<input type="file" accept="application/pdf" id="cls-pdf-file" style="display:none"></label>
                <span id="cls-pdf-name" class="muted" style="font-size:12px"></span>
                <button class="btn sm danger hidden" id="cls-pdf-remove-file" style="flex:0 0 auto">🗑️ حذف فایل PDF</button>
              </div>
              <div id="cls-pdf-nav" class="row hidden" style="align-items:center;margin-top:6px;flex-wrap:wrap">
                <button class="btn sm gray" id="cls-pdf-prev" style="flex:0 0 auto">◀ قبلی</button>
                <span style="flex:0 0 auto">صفحه <input type="number" id="cls-pdf-pagenum" min="1" value="1" style="width:60px;text-align:center"> از <span id="cls-pdf-total">1</span></span>
                <button class="btn sm gray" id="cls-pdf-next" style="flex:0 0 auto">بعدی ▶</button>
                <button class="btn sm primary" id="cls-pdf-show" style="flex:0 0 auto">🖼️ نمایش این صفحه روی تخته</button>
                <button class="btn sm danger" id="cls-pdf-remove-bg" style="flex:0 0 auto">حذف PDF از تخته</button>
              </div>
            </div>
            <div class="row" style="margin-bottom:8px;flex-wrap:wrap">
              <input type="color" id="brd-color" value="#111827" style="flex:0 0 44px;padding:2px;height:38px">
              <input type="range" id="brd-size" min="1" max="20" value="3" style="flex:1;min-width:80px">
              <button class="btn sm gray active" id="brd-tool-pen" style="flex:0 0 auto">✏️ قلم</button>
              <button class="btn sm gray" id="brd-tool-line" style="flex:0 0 auto">📏 خط راست</button>
              <button class="btn sm gray" id="brd-tool-text" style="flex:0 0 auto">🔤 متن</button>
              <button class="btn sm gray" id="brd-tool-eraser" style="flex:0 0 auto">🧽 پاک‌کن</button>
              <button class="btn sm danger" id="brd-clear" style="flex:0 0 auto">🗑️ پاک کردن یادداشت‌ها</button>
            </div>
            <canvas id="t-board" width="900" height="500" style="width:100%;background:#fff;border:1px solid var(--line);border-radius:10px;touch-action:none;display:block;cursor:crosshair"></canvas>
            <p class="muted" style="font-size:12px;margin-top:6px">روی تخته بکشید؛ ترسیم برای همه دانش‌آموزان متصل به‌صورت زنده نمایش داده می‌شود.</p>
          </div>
          <div class="cls-chat-col">
            <h4 style="margin:0 0 6px">👥 حاضرین (<span id="cls-online-count">0</span>)</h4>
            <div id="cls-participants" class="muted" style="font-size:13px;max-height:110px;overflow:auto;margin-bottom:10px"></div>
            <div id="t-chatBox" style="height:220px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:10px;background:#fafafa;display:flex;flex-direction:column;gap:6px"></div>
            <div class="row" style="margin-top:8px">
              <input id="t-chatInput" placeholder="پیام به کلاس...">
              <button class="btn sm" id="t-btnSend" style="flex:0 0 auto">ارسال</button>
              <button class="btn sm gray" id="t-btnFile" style="flex:0 0 auto" title="ارسال فایل">📎</button>
              <input type="file" id="t-fileInput" style="display:none">
            </div>
          </div>
        </div>

        <hr style="border:none;border-top:1px solid var(--line);margin:16px 0">
        <h4>🔗 لینک‌های اختصاصی ورود دانش‌آموزان به کلاس</h4>
        <p class="muted">برای هر دانش‌آموزی که در تب «دانش‌آموزان» ساخته‌اید، یک لینک اختصاصی کلاس آنلاین وجود دارد؛ کافیست دانش‌آموز روی لینک بزند تا مستقیم وارد کلاس شود.</p>
        <div id="cls-links-list"></div>
      </div>

      <div class="card tab-content hidden" id="tab-logbook">
        <div id="lb-menu">
          <h3>📔 دفتر مدیریت کلاسی</h3>
          <p class="muted">مجموعه‌ی فرم‌های اداری و آموزشی معلم؛ هرکدام را انتخاب کنید تا وارد شوید. همه قابل دانلود Word، Excel و چاپ/PDF هستند.</p>
          <div class="lb-menu-grid">
            <button class="lb-menu-btn" data-lb="pacing"><span class="lb-ico">📊</span><span class="lb-t">جدول بودجه‌بندی آموزشی</span><small>پایه‌های اول تا ششم</small></button>
            <button class="lb-menu-btn" data-lb="roster"><span class="lb-ico">👨‍🎓</span><span class="lb-t">لیست اسامی دانش‌آموزان</span></button>
            <button class="lb-menu-btn" data-lb="genderstats"><span class="lb-ico">📊</span><span class="lb-t">آمار دانش‌آموزان</span><small>به تفکیک جنسیت</small></button>
            <button class="lb-menu-btn" data-lb="absence"><span class="lb-ico">📋</span><span class="lb-t">ثبت غیبت دانش‌آموزان</span></button>
            <button class="lb-menu-btn" data-lb="performance"><span class="lb-ico">📈</span><span class="lb-t">ثبت سطوح عملکرد دانش‌آموز</span></button>
            <button class="lb-menu-btn" data-lb="council"><span class="lb-ico">🗣️</span><span class="lb-t">صورتجلسه شورای آموزشی اولیا</span></button>
            <button class="lb-menu-btn" data-lb="meetings"><span class="lb-ico">🤝</span><span class="lb-t">جلسات فردی با اولیا</span></button>
            <button class="lb-menu-btn" data-lb="weekly"><span class="lb-ico">📅</span><span class="lb-t">برنامه درسی هفتگی (چندپایه)</span></button>
            <button class="lb-menu-btn" data-lb="weekly2"><span class="lb-ico">🗓️</span><span class="lb-t">برنامه درسی هفتگی (تک‌پایه)</span></button>
            <button class="lb-menu-btn" data-lb="staff"><span class="lb-ico">🧑‍🏫</span><span class="lb-t">اطلاعات پرسنلی همکاران مدرسه</span></button>
          </div>
        </div>

        <!-- ===== ۱. جدول بودجه‌بندی آموزشی ===== -->
        <div class="lb-panel hidden" id="lb-panel-pacing">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>📊 جدول بودجه‌بندی آموزشی</h3>
          <div class="lb-meta-form">
            <div><label>نام مدرسه</label><input id="lbp-school" placeholder="......................."></div>
            <div><label>نام آموزگار</label><input id="lbp-teacher" placeholder="......................."></div>
            <div><label>سال تحصیلی</label><input id="lbp-year" placeholder="......................."></div>
          </div>
          <div class="row" style="align-items:center">
            <label style="flex:0 0 auto">پایه تحصیلی:</label>
            <select id="lbp-grade-select" style="flex:0 0 auto;min-width:180px">
              <option value="0">پایه اول دبستان</option>
              <option value="1">پایه دوم دبستان</option>
              <option value="2">پایه سوم دبستان</option>
              <option value="3">پایه چهارم دبستان</option>
              <option value="4">پایه پنجم دبستان</option>
              <option value="5">پایه ششم دبستان</option>
            </select>
          </div>
          <p class="muted">در هر خانه‌ی جدول: شماره درس، صفحات کتاب، زمان تدریس و توضیحات معلم یادداشت می‌شود.</p>
          <div id="lb-pacing-preview" class="lb-preview"></div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lbp-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lb-pacing-word">📄 دانلود Word (این پایه)</button>
            <button class="btn sec" id="btn-lb-pacing-excel">📊 دانلود Excel (این پایه)</button>
            <button class="btn gray" id="btn-lb-pacing-pdf">🖨️ چاپ / دانلود PDF (این پایه)</button>
            <button class="btn danger" type="button" onclick="lbClearContainer('lb-pacing-preview')">🗑️ پاک کردن جدول</button>
          </div>
        </div>

        <!-- ===== ۲. لیست اسامی دانش‌آموزان ===== -->
        <div class="lb-panel hidden" id="lb-panel-roster">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>👨‍🎓 جدول لیست اسامی دانش‌آموزان</h3>
          <div class="lb-meta-form">
            <div><label>نام مدرسه</label><input id="lbr-school" placeholder="......................."></div>
            <div><label>نام آموزگار</label><input id="lbr-teacher" placeholder="......................."></div>
            <div><label>پایه تحصیلی</label><input id="lbr-grade" placeholder="......................."></div>
            <div><label>سال تحصیلی</label><input id="lbr-year" placeholder="......................."></div>
          </div>
          <div class="row">
            <label>تعداد ردیف: </label><input type="number" id="lbr-rows" value="30" min="1" max="100" style="width:90px">
            <button class="btn sm sec" id="btn-lbr-build">🔄 ساخت جدول</button>
            <button class="btn sm gray" id="btn-lbr-addrow">➕ افزودن ردیف (ادامه اسامی)</button>
          </div>
          <div class="lb-preview"><table class="lb-table" id="lbr-table"></table></div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lbr-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lb-roster-word">📄 دانلود Word</button>
            <button class="btn sec" id="btn-lb-roster-excel">📊 دانلود Excel</button>
            <button class="btn gray" id="btn-lb-roster-pdf">🖨️ چاپ / دانلود PDF</button>
            <button class="btn danger" type="button" onclick="lbClearContainer('lbr-table')">🗑️ پاک کردن جدول</button>
          </div>
        </div>

        <!-- ===== آمار دانش‌آموزان به تفکیک جنسیت ===== -->
        <div class="lb-panel hidden" id="lb-panel-genderstats">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <div class="lbg-sheet">
            <h3 class="lbg-title">آمار دانش‌آموزان مدرسه
              <input id="lbg-school" class="lbg-inline-input" placeholder="......................." style="width:180px">
              به تفکیک جنسیت سال تحصیلی
              <input id="lbg-year" class="lbg-inline-input" placeholder="......................." style="width:110px">
            </h3>
            <div class="lb-preview">
              <table class="lb-table lbg-table" id="lbg-table">
                <thead><tr><th>پایه</th><th>پسر</th><th>دختر</th><th>مجموع</th></tr></thead>
                <tbody>
                  <tr><td>اول</td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-boy" data-grade="1"></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-girl" data-grade="1"></td><td class="lbg-sum" data-grade="1">۰</td></tr>
                  <tr><td>دوم</td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-boy" data-grade="2"></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-girl" data-grade="2"></td><td class="lbg-sum" data-grade="2">۰</td></tr>
                  <tr><td>سوم</td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-boy" data-grade="3"></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-girl" data-grade="3"></td><td class="lbg-sum" data-grade="3">۰</td></tr>
                  <tr><td>چهارم</td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-boy" data-grade="4"></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-girl" data-grade="4"></td><td class="lbg-sum" data-grade="4">۰</td></tr>
                  <tr><td>پنجم</td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-boy" data-grade="5"></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-girl" data-grade="5"></td><td class="lbg-sum" data-grade="5">۰</td></tr>
                  <tr><td>ششم</td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-boy" data-grade="6"></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-girl" data-grade="6"></td><td class="lbg-sum" data-grade="6">۰</td></tr>
                </tbody>
                <tfoot><tr class="lbg-total-row"><td>مجموع کل</td><td id="lbg-foot-boy">۰</td><td id="lbg-foot-girl">۰</td><td id="lbg-foot-all">۰</td></tr></tfoot>
              </table>
            </div>
            <div class="lbg-boxes">
              <div class="lbg-box"><span class="lbg-box-label">تعداد دانش‌آموزان پسر</span><span class="lbg-box-val" id="lbg-total-boy">۰</span></div>
              <div class="lbg-box"><span class="lbg-box-label">تعداد دانش‌آموزان دختر</span><span class="lbg-box-val" id="lbg-total-girl">۰</span></div>
              <div class="lbg-box lbg-box-main"><span class="lbg-box-label">تعداد کل دانش‌آموزان مدرسه</span><span class="lbg-box-val" id="lbg-total-all">۰</span></div>
            </div>
          </div>
          <div class="row" style="margin-top:16px">
            <button class="btn primary" id="btn-lbg-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lbg-word">📄 دانلود Word</button>
            <button class="btn sec" id="btn-lbg-excel">📊 دانلود Excel</button>
            <button class="btn gray" id="btn-lbg-pdf">🖨️ چاپ / دانلود PDF</button>
            <button class="btn danger" type="button" onclick="lbClearContainer('lbg-table')">🗑️ پاک کردن جدول</button>
          </div>
        </div>

        <!-- ===== ۳. ثبت غیبت دانش‌آموزان ===== -->
        <div class="lb-panel hidden" id="lb-panel-absence">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>📋 جدول ثبت غیبت دانش‌آموزان</h3>
          <div class="lb-meta-form">
            <div><label>نام مدرسه</label><input id="lba-school" placeholder="......................."></div>
            <div><label>نام آموزگار</label><input id="lba-teacher" placeholder="......................."></div>
            <div><label>پایه تحصیلی</label><input id="lba-grade" placeholder="......................."></div>
            <div><label>سال تحصیلی</label><input id="lba-year" placeholder="......................."></div>
          </div>
          <p class="muted">راهنما: موجه «م» | غیرموجه «غ» | تأخیر «ت»</p>
          <div class="row">
            <label>ماه: </label>
            <select id="lba-month">
              <option>مهر</option><option>آبان</option><option>آذر</option><option>دی</option><option>بهمن</option><option>اسفند</option><option>فروردین</option><option>اردیبهشت</option><option>خرداد</option>
            </select>
            <label>تعداد روز: </label><input type="number" id="lba-days" value="30" min="28" max="31" style="width:80px">
            <label>تعداد دانش‌آموز: </label><input type="number" id="lba-rows" value="30" min="1" max="60" style="width:80px">
            <button class="btn sm sec" id="btn-lba-build">🔄 ساخت جدول</button>
            <button class="btn sm gray" id="btn-lba-addrow">➕ افزودن ردیف (ادامه جدول)</button>
          </div>
          <div class="lb-preview"><table class="lb-table lb-table-tight" id="lba-table"></table></div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lba-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lb-absence-word">📄 دانلود Word</button>
            <button class="btn sec" id="btn-lb-absence-excel">📊 دانلود Excel</button>
            <button class="btn gray" id="btn-lb-absence-pdf">🖨️ چاپ / دانلود PDF</button>
            <button class="btn danger" type="button" onclick="lbClearContainer('lba-table')">🗑️ پاک کردن جدول</button>
          </div>
        </div>

        <!-- ===== ۴. ثبت سطوح عملکرد دانش‌آموز ===== -->
        <div class="lb-panel hidden" id="lb-panel-performance">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>📈 جدول شماره ۸: ثبت سطوح عملکرد دانش‌آموز</h3>
          <p class="muted">ثبت سطوح عملکرد دانش‌آموز براساس انتظارات آموزشی هر یک از کتب درسی</p>
          <div class="row" style="align-items:center">
            <label style="flex:0 0 auto">پایه تحصیلی:</label>
            <select id="lbf-grade-select" style="flex:0 0 auto;min-width:180px">
              <option value="0">پایه اول دبستان</option>
              <option value="1">پایه دوم دبستان</option>
              <option value="2">پایه سوم دبستان</option>
              <option value="3">پایه چهارم دبستان</option>
              <option value="4">پایه پنجم دبستان</option>
              <option value="5">پایه ششم دبستان</option>
            </select>
          </div>
          <div class="row" style="align-items:center;flex-wrap:wrap;gap:8px">
            <label style="flex:0 0 auto">دانش‌آموز:</label>
            <select id="lbf-student-select" style="flex:0 0 auto;min-width:220px">
              <option value="">— انتخاب دانش‌آموز —</option>
            </select>
            <button class="btn sm sec" id="btn-lbf-new">🆕 دانش‌آموز جدید</button>
            <button class="btn sm danger hidden" id="btn-lbf-delete">🗑️ حذف این دانش‌آموز</button>
          </div>
          <div id="lbf-form-wrap" class="hidden">
            <div class="row" style="align-items:center;gap:14px;margin:10px 0">
              <img id="lbf-photo-preview" class="hidden" style="width:44px;height:44px;border-radius:50%;object-fit:cover;border:1px solid var(--line)">
              <label class="btn sm sec" style="cursor:pointer">📷 عکس پروفایل دانش‌آموز<input type="file" accept="image/*" id="lbf-photo-input" style="display:none"></label>
              <button class="btn sm gray hidden" id="btn-lbf-photo-remove">🗑️ حذف عکس</button>
            </div>
            <div class="lb-meta-form">
              <div><label>نام مدرسه</label><input id="lbf-school" placeholder="......................."></div>
              <div><label>نام آموزگار</label><input id="lbf-teacher" placeholder="......................."></div>
              <div><label>سال تحصیلی</label><input id="lbf-year" placeholder="......................."></div>
              <div><label>نام دانش‌آموز</label><input id="lbf-student-name" placeholder="نام و نام خانوادگی دانش‌آموز"></div>
            </div>
            <div class="row">
              <label>تعداد ستون‌های ثبت عملکرد: </label><input type="number" id="lbf-cols" value="12" min="1" max="60" style="width:80px">
              <button class="btn sm sec" id="btn-lbf-build">🔄 ساخت جدول</button>
            </div>
            <div class="lb-preview" id="lb-performance-preview"></div>
            <p class="muted" style="margin-top:10px">لازم به ذکر است انتظارات آموزشی تمامی پایه‌ها در جدول شماره ۸ ارائه گردیده. آموزگاران بر پایه بر انتظارات پیش‌بینی شده نسبت به تکمیل جدول اقدام می‌نمایند.</p>
            <div class="row" style="margin-top:12px">
              <button class="btn primary" id="btn-lbf-save">💾 ذخیره</button>
              <button class="btn primary" id="btn-lb-performance-word">📄 دانلود Word</button>
              <button class="btn sec" id="btn-lb-performance-excel">📊 دانلود Excel</button>
              <button class="btn gray" id="btn-lb-performance-pdf">🖨️ چاپ / دانلود PDF</button>
              <button class="btn danger" type="button" onclick="lbClearContainer('lb-performance-preview')">🗑️ پاک کردن جدول</button>
            </div>
          </div>
        </div>

        <!-- ===== ۵. صورتجلسه شورای آموزشی اولیا ===== -->
        <div class="lb-panel hidden" id="lb-panel-council">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>🗣️ جدول شماره ۱: جلسات شورای آموزشی اولیا</h3>
          <div class="lb-meta-form">
            <div><label>تاریخ برگزاری</label><input id="lbc-date" placeholder="......................."></div>
            <div><label>موضوع جلسه</label><input id="lbc-topic" placeholder="......................."></div>
            <div><label>شماره جلسه</label><input id="lbc-num" placeholder="......................."></div>
            <div><label>ساعت تشکیل</label><input id="lbc-time" placeholder="......................."></div>
          </div>
          <label>۱- خلاصه مباحث مطرح شده</label>
          <textarea id="lbc-summary" rows="5" class="lb-textarea" placeholder="شرح مباحث و موضوعات مطرح‌شده در جلسه..."></textarea>
          <label>۲- تصمیمات و پیشنهادهای ارائه‌شده</label>
          <textarea id="lbc-decisions" rows="5" class="lb-textarea" placeholder="مصوبات، پیشنهادها و راهکارهای آموزشی..."></textarea>
          <div class="row">
            <label>۳- تعداد اعضای جلسه: </label><input type="number" id="lbc-rows" value="10" min="1" max="40" style="width:80px">
            <button class="btn sm sec" id="btn-lbc-build">🔄 ساخت جدول اعضا</button>
            <button class="btn sm gray" id="btn-lbc-addrow">➕ افزودن ردیف</button>
          </div>
          <div class="lb-preview"><table class="lb-table" id="lbc-table"></table></div>
          <p style="margin-top:10px"><b>امضاء و تأیید مدیر مدرسه:</b> .......................</p>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lbc-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lb-council-word">📄 دانلود Word</button>
            <button class="btn sec" id="btn-lb-council-excel">📊 دانلود Excel</button>
            <button class="btn gray" id="btn-lb-council-pdf">🖨️ چاپ / دانلود PDF</button>
            <button class="btn danger" type="button" onclick="lbClearContainer('lbc-table')">🗑️ پاک کردن جدول</button>
          </div>
        </div>

        <!-- ===== ۶. جلسات فردی با اولیا ===== -->
        <div class="lb-panel hidden" id="lb-panel-meetings">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>🤝 جدول ۱۰ - جلسات فردی با اولیا</h3>
          <div class="lb-meta-form">
            <div><label>نام مدرسه</label><input id="lbm-school" placeholder="......................."></div>
            <div><label>نام آموزگار</label><input id="lbm-teacher" placeholder="......................."></div>
            <div><label>پایه تحصیلی</label><input id="lbm-grade" placeholder="......................."></div>
            <div><label>سال تحصیلی</label><input id="lbm-year" placeholder="......................."></div>
          </div>
          <div class="row">
            <label>تعداد ردیف: </label><input type="number" id="lbm-rows" value="15" min="1" max="60" style="width:80px">
            <button class="btn sm sec" id="btn-lbm-build">🔄 ساخت جدول</button>
            <button class="btn sm gray" id="btn-lbm-addrow">➕ افزودن ردیف (ادامه جلسات)</button>
          </div>
          <div class="lb-preview"><table class="lb-table" id="lbm-table"></table></div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lbm-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lb-meetings-word">📄 دانلود Word</button>
            <button class="btn sec" id="btn-lb-meetings-excel">📊 دانلود Excel</button>
            <button class="btn gray" id="btn-lb-meetings-pdf">🖨️ چاپ / دانلود PDF</button>
            <button class="btn danger" type="button" onclick="lbClearContainer('lbm-table')">🗑️ پاک کردن جدول</button>
          </div>
        </div>

        <!-- ===== ۷. برنامه درسی هفتگی (ویژه چندپایه) ===== -->
        <div class="lb-panel hidden" id="lb-panel-weekly">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>📅 جدول ۱-۳-۱ ـ برنامه درسی هفتگی (ویژه چندپایه)</h3>
          <div class="lb-meta-form">
            <div><label>نام مدرسه</label><input id="lbw-school" placeholder="......................."></div>
            <div><label>نام آموزگار</label><input id="lbw-teacher" placeholder="......................."></div>
            <div><label>کلاس</label><input id="lbw-class" placeholder="......................."></div>
          </div>
          <div class="row" style="flex-wrap:wrap;gap:10px;align-items:center">
            <label style="flex:0 0 auto">پایه‌هایی که تدریس می‌کنید:</label>
            <label style="flex:0 0 auto"><input type="checkbox" class="lbw-grade-chk" checked> اول</label>
            <label style="flex:0 0 auto"><input type="checkbox" class="lbw-grade-chk" checked> دوم</label>
            <label style="flex:0 0 auto"><input type="checkbox" class="lbw-grade-chk" checked> سوم</label>
            <label style="flex:0 0 auto"><input type="checkbox" class="lbw-grade-chk" checked> چهارم</label>
            <label style="flex:0 0 auto"><input type="checkbox" class="lbw-grade-chk" checked> پنجم</label>
            <label style="flex:0 0 auto"><input type="checkbox" class="lbw-grade-chk" checked> ششم</label>
            <button class="btn sm sec" id="btn-lbw-build">🔄 ساخت جدول</button>
          </div>
          <div class="lb-preview" id="lb-weekly-preview"></div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lbw-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lb-weekly-word">📄 دانلود Word</button>
            <button class="btn sec" id="btn-lb-weekly-excel">📊 دانلود Excel</button>
            <button class="btn gray" id="btn-lb-weekly-pdf">🖨️ چاپ / دانلود PDF</button>
            <button class="btn danger" type="button" onclick="lbClearContainer('lb-weekly-preview')">🗑️ پاک کردن جدول</button>
          </div>
        </div>

        <!-- ===== ۸. برنامه درسی هفتگی (کلاس تک‌پایه) ===== -->
        <div class="lb-panel hidden" id="lb-panel-weekly2">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>🗓️ جدول ۳- برنامه درسی هفتگی (کلاس تک پایه)</h3>
          <div class="lb-meta-form">
            <div><label>نام مدرسه</label><input id="lbw2-school" placeholder="......................."></div>
            <div><label>نام آموزگار</label><input id="lbw2-teacher" placeholder="......................."></div>
            <div><label>پایه</label><input id="lbw2-grade" placeholder="......................."></div>
            <div><label>کلاس</label><input id="lbw2-class" placeholder="......................."></div>
          </div>
          <div class="lb-preview" id="lb-weekly2-preview"></div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lbw2-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lb-weekly2-word">📄 دانلود Word</button>
            <button class="btn sec" id="btn-lb-weekly2-excel">📊 دانلود Excel</button>
            <button class="btn gray" id="btn-lb-weekly2-pdf">🖨️ چاپ / دانلود PDF</button>
            <button class="btn danger" type="button" onclick="lbClearContainer('lb-weekly2-preview')">🗑️ پاک کردن جدول</button>
          </div>
        </div>

        <!-- ===== ۹. اطلاعات پرسنلی همکاران مدرسه ===== -->
        <div class="lb-panel hidden" id="lb-panel-staff">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>🧑‍🏫 اطلاعات پرسنلی همکاران مدرسه</h3>
          <div class="lb-meta-form">
            <div><label>سال تحصیلی</label><input id="lbs-year" placeholder="......................."></div>
          </div>
          <div class="row">
            <label>تعداد ردیف: </label><input type="number" id="lbs-rows" value="15" min="1" max="60" style="width:80px">
            <button class="btn sm sec" id="btn-lbs-build">🔄 ساخت جدول</button>
            <button class="btn sm gray" id="btn-lbs-addrow">➕ افزودن ردیف</button>
          </div>
          <div class="lb-preview"><table class="lb-table lb-table-zebra" id="lbs-table"></table></div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lbs-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lb-staff-word">📄 دانلود Word</button>
            <button class="btn sec" id="btn-lb-staff-excel">📊 دانلود Excel</button>
            <button class="btn gray" id="btn-lb-staff-pdf">🖨️ چاپ / دانلود PDF</button>
            <button class="btn danger" type="button" onclick="lbClearContainer('lbs-table')">🗑️ پاک کردن جدول</button>
          </div>
        </div>


      </div>


      <div class="card tab-content hidden" id="tab-settings">
        <h3>🌙 تم</h3>
        <div style="display:flex;gap:12px;margin-bottom:20px">
          <button class="theme-btn" data-theme="light" onclick="setTheme('light')">☀️ روشن</button>
          <button class="theme-btn" data-theme="dark" onclick="setTheme('dark')">🌙 تاریک</button>
        </div>
        <h3>🤖 موتور هوش مصنوعی</h3>
        <p class="muted" style="margin-bottom:20px">تمام قابلیت‌های هوش مصنوعی (ترجمه، استخراج متن از عکس/PDF، چت دستیار و ...) با موتور ✨ Gemini انجام می‌شود.</p>
        <h3>🔐 تغییر رمز عبور</h3>
        <label>رمز عبور جدید</label><input id="new-pass" type="password" autocomplete="new-password">
        <p class="muted" id="pass-msg"></p>
        <button class="btn" id="btn-change-pass">ذخیره رمز جدید</button>
      </div>
    </div>
  </div>
  <div class="toast" id="toast"></div>
  <script>${teacherScript()}</script>
  </body></html>`;
}

/* ------------------------- اسکریپت معلم (کامل) ------------------------- */

function teacherScript() {
  return `
  const TYPES={descriptive:'تشریحی',multiple:'چهارگزینه‌ای',truefalse:'صحیح/غلط',short:'کوتاه‌پاسخ'};
  const MATH=['+','\u2212','\u00d7','\u00f7','=','\u2260','\u00b1','\u2213','<','>','\u2264','\u2265','\u221a','\u221b','\u221c','%','\u2030','\u03c0','\u00b0',
    '\u00bd','\u2153','\u2154','\u00bc','\u00be','\u2155','\u2156','\u2157','\u2158','\u2159','\u215a','\u215b','\u215c','\u215d','\u215e',
    '\u00b2','\u00b3','\u2070','\u00b9','\u2074','\u2075',
    '( )','[ ]','{ }','\u2211','\u220f','\u221e','\u2220','\u22a5','\u2225','\u2234','\u2235','\u2248','\u2261','\u2245','\u221d','\u222b',
    '\u2192','\u2190','\u2194','\u2191','\u2193',
    '\u2208','\u2209','\u2282','\u2286','\u2284','\u222a','\u2229','\u2205',
    '\u2200','\u2203','\u00ac','\u2227','\u2228','\u2295','\u0394','\u2202','\u2207'];
  const SHAPES=['\u25b3','\u25bd','\u25c1','\u25b7','\u25c0','\u25b6','\u25b2','\u25bc','\u25a1','\u25ad','\u25ac','\u25b1','\u25b0','\u25c7','\u25c6','\u2b20','\u2b1f','\u2b21','\u2b22','\u25cb','\u25ef','\u25cf','\u2b24','\u2b2d','\u2605','\u2606','\u23e2','\u22bf','\u25e2','\u25e3','\u25e4','\u25e5','\u2194','\u2191','\u2193','\u2220','\u22a5','\u2225','\u2312','\u2299','\u2014'];
  const SVG_SHAPES=[
    {name:'مکعب', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><rect x="20" y="35" width="45" height="45"/><path d="M20 35 L40 15 L85 15 L65 35"/><path d="M65 35 L65 80 L85 60 L85 15"/></svg>'},
    {name:'استوانه', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><ellipse cx="50" cy="22" rx="30" ry="12"/><path d="M20 22 L20 78"/><path d="M80 22 L80 78"/><path d="M20 78 A30 12 0 0 0 80 78"/></svg>'},
    {name:'مخروط', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><path d="M50 12 L20 78"/><path d="M50 12 L80 78"/><ellipse cx="50" cy="78" rx="30" ry="11"/></svg>'},
    {name:'کره', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><circle cx="50" cy="50" r="36"/><ellipse cx="50" cy="50" rx="36" ry="13"/></svg>'},
    {name:'هرم', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><path d="M50 12 L18 75 L70 86 Z"/><path d="M50 12 L70 86 L86 64 Z"/><path d="M18 75 L70 86"/></svg>'},
    {name:'مستطیل‌مکعب', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><rect x="14" y="40" width="60" height="38"/><path d="M14 40 L30 22 L90 22 L74 40"/><path d="M74 40 L74 78 L90 60 L90 22"/></svg>'},
    {name:'زاویه', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 80 L85 80"/><path d="M20 80 L78 30"/><path d="M44 80 A24 24 0 0 0 38 64"/></svg>'},
    {name:'پاره‌خط', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><path d="M14 50 L86 50"/><circle cx="14" cy="50" r="4" fill="currentColor"/><circle cx="86" cy="50" r="4" fill="currentColor"/></svg>'}
  ];
  let QUESTIONS=[], META={}, SUBS=[], TABLES=[], RESIZE_IMAGES=[], scheduleData={cells:{}};
  
  function esc(s){const d=document.createElement('div');d.textContent=s==null?'':s;return d.innerHTML;}
  function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}
  window.addEventListener('error',function(e){
    console.error('خطای پیش‌بینی‌نشده:',e.error||e.message);
    try{toast('⚠️ خطایی رخ داد؛ لطفاً دوباره تلاش کنید');}catch(_){}
  });
  window.addEventListener('unhandledrejection',function(e){
    console.error('خطای پیش‌بینی‌نشده (async):',e.reason);
    try{toast('⚠️ خطایی رخ داد؛ لطفاً دوباره تلاش کنید');}catch(_){}
  });
  function uid(){return 'q-'+Math.random().toString(36).slice(2,10);}
  async function api(path,opts){const r=await fetch(path,opts);return r.json();}
  async function lbSave(key,value,silent){
    try{
      const d=await api('/api/teacher/lb-save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key,value})});
      if(!silent){if(d.ok)toast('ذخیره شد');else toast(d.error||'خطا در ذخیره');}
      return d.ok;
    }catch(e){if(!silent)toast('خطا در ذخیره');return false;}
  }
  async function lbLoad(key){
    try{
      const d=await api('/api/teacher/lb-load?key='+encodeURIComponent(key));
      return d.ok?d.value:null;
    }catch(e){return null;}
  }

  const savedTheme=localStorage.getItem('panelTheme')||'light';
  document.documentElement.setAttribute('data-theme',savedTheme);
  setTimeout(()=>{document.querySelectorAll('.theme-btn').forEach(b=>b.classList.toggle('active',b.dataset.theme===savedTheme));},100);
  window.setTheme=function(t){document.documentElement.setAttribute('data-theme',t);localStorage.setItem('panelTheme',t);document.querySelectorAll('.theme-btn').forEach(b=>b.classList.toggle('active',b.dataset.theme===t));};

  // ===== موتور هوش مصنوعی: فقط Gemini =====
  window.getAiProvider=function(){return 'gemini';};

  // ===== ورود =====
  async function checkAuth(){
    const d=await api('/api/teacher/state');
    if(d.auth){showDash();return;}
    if(!d.configured){
      document.getElementById('login-head').textContent='تعریف رمز عبور (اولین ورود)';
      document.getElementById('login-hint').textContent='این اولین ورود است؛ یک رمز دلخواه (حداقل ۴ کاراکتر) وارد کنید تا به‌عنوان رمز معلم ثبت شود.';
      document.getElementById('btn-login').textContent='ثبت رمز و ورود';
    }
  }
  document.getElementById('btn-login').onclick=async()=>{
    const p=document.getElementById('pass').value;
    const d=await api('/api/teacher/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:p})});
    if(d.ok){if(d.created)toast('رمز عبور شما ثبت شد');showDash();}else document.getElementById('login-err').textContent=d.error||'خطا';
  };
  document.getElementById('pass').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('btn-login').click();});
  document.getElementById('btn-logout').onclick=async()=>{await api('/api/teacher/logout',{method:'POST'});location.reload();};
  
  function showDash(){
    document.getElementById('login').classList.add('hidden');
    document.getElementById('dash').classList.remove('hidden');
    loadStudents();loadQuestions();loadSchedule();
  }

  document.querySelectorAll('.tab[data-tab]').forEach(t=>t.onclick=()=>{
    document.querySelectorAll('.tab[data-tab]').forEach(x=>x.classList.remove('active'));
    t.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c=>c.classList.add('hidden'));
    document.getElementById('tab-'+t.dataset.tab).classList.remove('hidden');
    if(t.dataset.tab==='tablesorg'){if(typeof loadTableIfNeeded==='function')loadTableIfNeeded();if(typeof loadOrgFormIfNeeded==='function')loadOrgFormIfNeeded();}
    if(t.dataset.tab==='schedule'){document.getElementById('btn-gen-schedule').click();if(typeof loadScheduleThemeIfNeeded==='function')loadScheduleThemeIfNeeded();}
    if(t.dataset.tab==='classroom'){renderClassLinks();setTimeout(function(){if(typeof clsResizeBoard==='function')clsResizeBoard();},50);}
    if(t.dataset.tab==='examsheet'){if(typeof loadExamSheetIfNeeded==='function')loadExamSheetIfNeeded();}
  });

  document.querySelectorAll('.subtab[data-subtab]').forEach(t=>t.onclick=()=>{
    document.querySelectorAll('.subtab[data-subtab]').forEach(x=>x.classList.remove('active'));
    t.classList.add('active');
    document.querySelectorAll('.subtab-content').forEach(c=>c.classList.add('hidden'));
    document.getElementById('tab-'+t.dataset.subtab).classList.remove('hidden');
    if(t.dataset.subtab==='answers')loadAnswers();
    if(t.dataset.subtab==='worksheet')loadWorksheetList();
    if(t.dataset.subtab==='questions'){updateDurationDisplay();}
  });

  // ===== دانش‌آموزان =====
  async function loadStudents(){
    const d=await api('/api/teacher/students');
    const box=document.getElementById('students-list');
    if(!d.students.length){box.innerHTML='<p class="muted">هنوز دانش‌آموزی ساخته نشده است.</p>';return;}
    box.innerHTML='<table><tr><th>عکس</th><th>#</th><th>نام</th><th>لینک اختصاصی</th><th>وضعیت</th><th></th></tr>'+
      d.students.map((s,i)=>{
        const link=location.origin+'/s/'+s.uuid;
        let st='<span class="pill no">در انتظار</span>';
        if(s.status==='submitted')st='<span class="pill gr">ثبت‌شده (تصحیح‌نشده)</span>';
        if(s.status==='graded')st='<span class="pill ok">تصحیح‌شده</span>';
        const avatar=s.photo?'<img src="'+s.photo+'" style="width:36px;height:36px;border-radius:50%;object-fit:cover;display:block">':'<div style="width:36px;height:36px;border-radius:50%;background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:16px">🧑‍🎓</div>';
        return '<tr><td>'+avatar+'</td><td>'+(i+1)+'</td><td>'+esc(s.label||'-')+'</td>'+
          '<td><div class="link-box">'+link+'</div></td>'+
          '<td>'+st+'</td>'+
          '<td><button class="btn sm" onclick="copyLink(\\''+link+'\\')">کپی</button> '+
          '<label class="btn sm sec" style="cursor:pointer">📷 عکس<input type="file" accept="image/*" style="display:none" onchange="changeStudentPhoto(\\''+s.uuid+'\\',this)"></label> '+
          '<button class="btn sm danger" onclick="delStudent(\\''+s.uuid+'\\')">حذف</button></td></tr>';
      }).join('')+'</table>';
  }
  window.copyLink=(l)=>{navigator.clipboard.writeText(l).then(()=>toast('لینک کپی شد'));};
  window.delStudent=async(id)=>{if(!confirm('حذف این دانش‌آموز و پاسخنامه‌اش؟'))return;await api('/api/teacher/students/'+id,{method:'DELETE'});loadStudents();};

  // کوچک‌کردن و برش مرکزی عکس پروفایل به یک مربع کامل (مثل آپلود عکس پروفایل واقعی) تا داخل دایره هیچ‌وقت کشیده/بیضی به‌نظر نرسد
  function resizeProfilePhoto(file){
    return new Promise((resolve,reject)=>{
      if(file.size>2*1024*1024){reject(new Error('حجم عکس باید کمتر از ۲ مگابایت باشد'));return;}
      const rd=new FileReader();
      rd.onload=ev=>{
        const img=new Image();
        img.onload=()=>{
          const size=320;
          // برش مرکزی: بزرگ‌ترین مربع ممکن از وسط عکس اصلی انتخاب می‌شود تا نسبت تصویر به‌هم نخورد
          const side=Math.min(img.width,img.height);
          const sx=(img.width-side)/2, sy=(img.height-side)/2;
          const c=document.createElement('canvas');c.width=size;c.height=size;
          c.getContext('2d').drawImage(img,sx,sy,side,side,0,0,size,size);
          resolve(c.toDataURL('image/jpeg',0.85));
        };
        img.onerror=()=>reject(new Error('فایل عکس معتبر نیست'));
        img.src=ev.target.result;
      };
      rd.onerror=()=>reject(new Error('خطا در خواندن فایل'));
      rd.readAsDataURL(file);
    });
  }

  // فشرده‌سازی عکس کاربرگ تا زیر ۲ مگابایت (با حفظ خوانایی متن، برخلاف عکس پروفایل که کوچک می‌شود)
  function compressWorksheetImage(file){
    return new Promise((resolve,reject)=>{
      const rd=new FileReader();
      rd.onload=ev=>{
        const img=new Image();
        img.onload=()=>{
          let w=img.width,h=img.height;
          const maxDim=2000;
          if(Math.max(w,h)>maxDim){
            const scale=maxDim/Math.max(w,h);
            w=Math.round(w*scale);h=Math.round(h*scale);
          }
          const c=document.createElement('canvas');c.width=w;c.height=h;
          const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(img,0,0,w,h);
          let quality=0.9;
          function tryCompress(){
            c.toBlob(function(blob){
              if(!blob){reject(new Error('خطا در فشرده‌سازی'));return;}
              if(blob.size<=2*1024*1024||quality<=0.3){
                const fr=new FileReader();
                fr.onload=()=>resolve(fr.result);
                fr.readAsDataURL(blob);
              }else{
                quality-=0.1;
                tryCompress();
              }
            },'image/jpeg',quality);
          }
          tryCompress();
        };
        img.onerror=()=>reject(new Error('فایل عکس معتبر نیست'));
        img.src=ev.target.result;
      };
      rd.onerror=()=>reject(new Error('خطا در خواندن فایل'));
      rd.readAsDataURL(file);
    });
  }

  let newStudentPhoto='';
  document.getElementById('new-student-photo').addEventListener('change',async function(){
    const f=this.files&&this.files[0];this.value='';
    if(!f)return;
    try{
      newStudentPhoto=await resizeProfilePhoto(f);
      const prev=document.getElementById('new-student-photo-preview');
      prev.src=newStudentPhoto;prev.classList.remove('hidden');
    }catch(e){toast(e.message);}
  });

  window.changeStudentPhoto=async(id,input)=>{
    const f=input.files&&input.files[0];input.value='';
    if(!f)return;
    try{
      const photo=await resizeProfilePhoto(f);
      const r=await api('/api/teacher/students/'+id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({photo})});
      if(r.ok){toast('عکس پروفایل بروزرسانی شد ✅');loadStudents();}
      else{toast('خطا: '+(r.error||'ثبت نشد'));}
    }catch(e){toast(e.message);}
  };

  document.getElementById('btn-add-student').onclick=async()=>{
    const label=document.getElementById('new-label').value.trim();
    const btn=document.getElementById('btn-add-student');btn.disabled=true;
    try{
      const r=await api('/api/teacher/students',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label,photo:newStudentPhoto})});
      if(!r.ok){toast('خطا: '+(r.error||'ساخته نشد'));return;}
      document.getElementById('new-label').value='';
      newStudentPhoto='';
      document.getElementById('new-student-photo-preview').classList.add('hidden');
      loadStudents();toast('دانش‌آموز ساخته شد ✅');
    }finally{btn.disabled=false;}
  };

  // ===== سوالات =====
  async function loadQuestions(){
    const d=await api('/api/teacher/questions');
    META=d.meta||{};
    QUESTIONS=d.questions||[];
    document.getElementById('m-school').value=META.school||'';
    document.getElementById('m-teacher').value=META.teacher||'';
    document.getElementById('m-exam-name').value=META.examName||'';
    document.getElementById('m-exam-duration').value=META.examDuration||'30';
    document.getElementById('m-grade-level').value=META.gradeLevel||'elementary';
    updateDurationDisplay();
    renderQ();
  }
  
  function updateDurationDisplay(){
    const duration = document.getElementById('m-exam-duration').value || '30';
    document.getElementById('duration-display').textContent = duration;
  }
  
  document.getElementById('m-exam-duration').addEventListener('input', updateDurationDisplay);
  
  // ===== محاسبه جمع وزن‌ها =====
  function calculateTotalWeight() {
    let total = 0;
    QUESTIONS.forEach(q => {
      total += (parseFloat(q.weight) || 1);
    });
    return total;
  }
  
  function updateWeightDisplay() {
    const total = calculateTotalWeight();
    const display = document.getElementById('weight-total-display');
    if (!display) return;
    if (Math.abs(total - 20) < 0.01) {
      display.innerHTML = '✅ جمع وزن‌ها: <span class="total-value valid">' + total.toFixed(1) + '</span> از 20 (صحیح)';
    } else {
      display.innerHTML = '⚠️ جمع وزن‌ها: <span class="total-value invalid">' + total.toFixed(1) + '</span> از 20 (باید برابر 20 باشد)';
    }
  }
  
  function renderQ(){
    const box=document.getElementById('q-list');
    box.innerHTML=QUESTIONS.map((q,i)=>qBlock(q,i)).join('')||'<p class="muted">سوالی اضافه نشده است.</p>';

    // نمایش جمع وزن‌ها (فقط یک‌بار ساخته می‌شود، نه هر بار رندر)
    let totalDiv = document.getElementById('weight-total-display');
    if (!totalDiv) {
      totalDiv = document.createElement('div');
      totalDiv.id = 'weight-total-display';
      totalDiv.className = 'weight-total';
      box.parentNode.insertBefore(totalDiv, box.nextSibling);
    }
    updateWeightDisplay();

    // نمایش خلاصه‌ی تعداد هر نوع سوال
    let summaryDiv = document.getElementById('q-type-summary');
    if (!summaryDiv) {
      summaryDiv = document.createElement('div');
      summaryDiv.id = 'q-type-summary';
      summaryDiv.className = 'muted';
      summaryDiv.style.cssText = 'font-size:13px;margin-top:6px';
      totalDiv.parentNode.insertBefore(summaryDiv, totalDiv.nextSibling);
    }
    const counts = {};
    QUESTIONS.forEach(q => { counts[q.type] = (counts[q.type]||0) + 1; });
    const parts = Object.keys(counts).map(t => (TYPES[t]||t) + ': ' + counts[t]);
    summaryDiv.textContent = QUESTIONS.length ? ('📊 تعداد کل سوالات: ' + QUESTIONS.length + ' (' + parts.join(' | ') + ')') : '';
  }
  
  function escA(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
  function qHtml(q){return q.rich?(q.text||''):esc(q.text);}
  function qBlock(q,i){
    let body='';
    const imgMode=Boolean(q.imageAsQuestion);

    // ===== سوییچ: تایپ متن یا بارگذاری عکس سوال =====
    body+='<div class="q-mode-toggle" style="margin-bottom:8px">'+
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:600">'+
      '<input type="checkbox" '+(imgMode?'checked':'')+' onchange="toggleQImageMode('+i+',this.checked)"> '+
      '🖼️ به‌جای تایپ متن، عکس سوال بارگذاری شود</label></div>';

    if(imgMode){
      // ===== حالت عکس سوال (بدون نیاز به تایپ متن) =====
      body+='<label>🖼️ عکس سوال</label>';
      if(q.image){
        const w=q.imageWidth||320;
        body+='<div><img src="'+q.image+'" class="imgprev" style="max-width:'+w+'px;width:100%"></div>'+
          '<div class="row" style="align-items:center;margin-top:6px">'+
          '<label style="flex:0 0 auto;margin:0">اندازه‌ی نمایش:</label>'+
          '<select onchange="updImgSize('+i+',this.value)" style="flex:0 0 auto;width:auto">'+
            [['180','کوچک'],['320','متوسط'],['500','بزرگ'],['800','تمام عرض برگه']].map(o=>'<option value="'+o[0]+'" '+(String(w)===o[0]?'selected':'')+'>'+o[1]+'</option>').join('')+
          '</select>'+
          '<button class="btn sm danger" type="button" onclick="rmImg('+i+')" style="flex:0 0 auto">حذف عکس</button></div>';
      }else{
        body+='<input type="file" accept="image/*" onchange="loadImg('+i+',this)">'+
          '<p class="muted" style="font-size:12px;margin-top:4px">عکس سوال را انتخاب کنید؛ نیازی به تایپ متن نیست.</p>';
      }
    }else if(q.type==='descriptive'){
      body+='<label>متن سوال</label>'+
        '<div class="rich" data-qd="'+i+'" contenteditable="true" oninput="updHtml('+i+')">'+qHtml(q)+'</div>';
    }else{
      body+='<label>متن سوال</label><textarea data-qd="'+i+'" oninput="upd('+i+',\\'text\\',this.value)">'+esc(q.text)+'</textarea>';
    }

    if(q.type==='multiple'){
      body+='<label>گزینه صحیح</label><select onchange="upd('+i+',\\'correct\\',this.value)">'+
        [0,1,2,3].map(n=>'<option value="'+n+'" '+(String(q.correct)===String(n)?'selected':'')+'>'+['الف','ب','ج','د'][n]+'</option>').join('')+'</select>';
      body+='<label>گزینه‌ها</label>';
      for(let oi=0;oi<4;oi++){
        body+='<div class="opt-row"><span>'+['الف','ب','ج','د'][oi]+')</span><input type="text" value="'+esc((q.options&&q.options[oi])||'')+'" oninput="updOpt('+i+','+oi+',this.value)"></div>';
      }
    }else if(q.type==='truefalse'){
      body+='<label>پاسخ صحیح</label><select onchange="upd('+i+',\\'correct\\',this.value)">'+
        '<option value="true" '+(String(q.correct)==='true'?'selected':'')+'>صحیح</option>'+
        '<option value="false" '+(String(q.correct)==='false'?'selected':'')+'>غلط</option></select>';
    }else if(q.type==='short'){
      body+='<label>پاسخ نمونه (اختیاری)</label><input type="text" value="'+esc(q.correct||'')+'" oninput="upd('+i+',\\'correct\\',this.value)">';
    }

    // ===== عکس / شکل کمکی اضافی (فقط وقتی حالت «عکس سوال» فعال نیست) =====
    if(!imgMode){
      body+='<label>🖼️ عکس / شکل (اختیاری)</label>';
      if(q.image){
        const w=q.imageWidth||320;
        body+='<div><img src="'+q.image+'" class="imgprev" style="max-width:'+w+'px;width:100%"></div>'+
          '<div class="row" style="align-items:center;margin-top:6px">'+
          '<label style="flex:0 0 auto;margin:0">اندازه‌ی نمایش:</label>'+
          '<select onchange="updImgSize('+i+',this.value)" style="flex:0 0 auto;width:auto">'+
            [['180','کوچک'],['320','متوسط'],['500','بزرگ'],['800','تمام عرض برگه']].map(o=>'<option value="'+o[0]+'" '+(String(w)===o[0]?'selected':'')+'>'+o[1]+'</option>').join('')+
          '</select>'+
          '<button class="btn sm danger" type="button" onclick="rmImg('+i+')" style="flex:0 0 auto">حذف عکس</button></div>';
      }else{
        body+='<input type="file" accept="image/*" onchange="loadImg('+i+',this)">';
      }
    }
    
    // ===== بخش وزن (ضریب) هر سوال =====
    body += \`
      <div class="weight-input-box">
        <label>⚖️ وزن (ضریب) این سوال:</label>
        <input type="number" id="weight_\${i}" value="\${q.weight || 1}" min="0.5" max="20" step="0.5" 
               onchange="updWeight(\${i}, this.value)">
        <span class="weight-hint">جمع وزن‌ها باید برابر 20 شود</span>
      </div>
    \`;
    
    return '<div class="q-block"><div class="qhead"><b>سوال '+(i+1)+'</b>'+
      '<span><span class="badge">'+TYPES[q.type]+'</span> '+
      '<button class="btn sm gray" onclick="moveQ('+i+',-1)">▲</button> '+
      '<button class="btn sm gray" onclick="moveQ('+i+',1)">▼</button> '+
      '<button class="btn sm gray" onclick="dupQ('+i+')">📋 کپی</button> '+
      '<button class="btn sm danger" onclick="delQ('+i+')">حذف</button></span></div>'+body+'</div>';
  }
  
  // ===== تابع جدید برای ذخیره وزن =====
  window.updWeight = (i, val) => {
    const weight = parseFloat(val);
    if (!isNaN(weight) && weight > 0) {
      QUESTIONS[i].weight = Math.min(20, Math.max(0.5, weight));
    } else {
      QUESTIONS[i].weight = 1;
      const el = document.getElementById('weight_'+i);
      if(el) el.value = 1;
    }
    updateWeightDisplay();
  };
  
  window.upd=(i,k,v)=>{QUESTIONS[i][k]=v;};
  window.updOpt=(i,oi,v)=>{QUESTIONS[i].options=QUESTIONS[i].options||['','','',''];QUESTIONS[i].options[oi]=v;};
  window.delQ=(i)=>{
    if(!confirm('این سوال حذف شود؟ این کار قابل بازگشت نیست.'))return;
    QUESTIONS.splice(i,1);renderQ();
  };
  window.dupQ=(i)=>{
    const copy=JSON.parse(JSON.stringify(QUESTIONS[i]));
    copy.id=uid();
    QUESTIONS.splice(i+1,0,copy);
    renderQ();
    toast('سوال کپی شد ✅');
  };
  window.moveQ=(i,dir)=>{const j=i+dir;if(j<0||j>=QUESTIONS.length)return;const t=QUESTIONS[i];QUESTIONS[i]=QUESTIONS[j];QUESTIONS[j]=t;renderQ();};
  window.distributeWeights=()=>{
    if(!QUESTIONS.length){toast('ابتدا سوالی اضافه کنید');return;}
    const each=Math.round((20/QUESTIONS.length)*2)/2; // رند به نزدیک‌ترین 0.5
    QUESTIONS.forEach(q=>q.weight=each);
    // اگر به‌خاطر رند کردن مجموع دقیقاً 20 نشد، اختلاف را به سوال آخر اضافه/کم می‌کنیم
    const diff=20-QUESTIONS.reduce((s,q)=>s+q.weight,0);
    if(Math.abs(diff)>0.001) QUESTIONS[QUESTIONS.length-1].weight=Math.max(0.5,QUESTIONS[QUESTIONS.length-1].weight+diff);
    renderQ();
    toast('وزن‌ها به‌طور مساوی تقسیم شدند ✅');
  };
  
  function richEl(i){return document.querySelector('.rich[data-qd="'+i+'"]');}
  function ssize(i){const r=document.getElementById('ssz-'+i);return r?parseInt(r.value,10):40;}
  function insHtmlAt(i,h){
    const el=richEl(i);if(!el)return;
    el.focus();
    const sel=document.getSelection();
    if(!sel.rangeCount||!el.contains(sel.anchorNode)){const r=document.createRange();r.selectNodeContents(el);r.collapse(false);sel.removeAllRanges();sel.addRange(r);}
    document.execCommand('insertHTML',false,h);
    updHtml(i);
  }
  window.insSym=(i,s)=>insHtmlAt(i,escA(s));
  window.insShape=(i,s)=>insHtmlAt(i,'<span class="shape" contenteditable="false" style="font-size:'+ssize(i)+'px">'+escA(s)+'</span>&#8203;');
  window.insSvg=(i,si)=>{const s=SVG_SHAPES[si];if(!s)return;const z=ssize(i);const svg=s.svg.replace('<svg','<svg width="'+z+'" height="'+z+'"');insHtmlAt(i,'<span class="shape" contenteditable="false">'+svg+'</span>&#8203;');};
  // تبدیل خودکار اعداد انگلیسی به فارسی، فقط در گره‌های متنی (بدون دست‌زدن به attribute ها مثل style/data تا ساختار خراب نشود)
  const FA_DIGITS=['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
  function toFaDigits(s){return String(s==null?'':s).replace(/[0-9]/g,d=>FA_DIGITS[+d]);}
  function toEnDigits(s){return String(s==null?'':s).replace(/[۰-۹]/g,d=>FA_DIGITS.indexOf(d));}
  function convertDigitsInElement(el){
    if(!el)return;
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null);
    const nodes=[];let n;
    while(n=walker.nextNode())nodes.push(n);
    nodes.forEach(node=>{if(/[0-9]/.test(node.textContent))node.textContent=toFaDigits(node.textContent);});
  }

  window.updHtml=(i)=>{const el=richEl(i);if(!el)return;convertDigitsInElement(el);const c=el.cloneNode(true);c.querySelectorAll('.shape').forEach(s=>{s.style.outline='';});QUESTIONS[i].text=c.innerHTML;QUESTIONS[i].rich=true;};

  // ===== فرمول‌ساز ریاضی (شبیه MathType) =====
  let mtTargetIndex=null;
  window.openMathBuilder=(i)=>{
    mtTargetIndex=i;
    document.getElementById('mt-canvas').innerHTML='';
    document.getElementById('mt-modal-overlay').classList.remove('hidden');
    setTimeout(()=>document.getElementById('mt-canvas').focus(),50);
  };
  window.closeMathBuilder=()=>{
    document.getElementById('mt-modal-overlay').classList.add('hidden');
  };
  window.mtInsertIntoQuestion=()=>{
    if(mtTargetIndex===null)return;
    const canvas=document.getElementById('mt-canvas');
    convertDigitsInElement(canvas);
    const h=canvas.innerHTML.trim();
    if(!h){toast('ابتدا یک فرمول بسازید');return;}
    insHtmlAt(mtTargetIndex,h+'\u200b');
    closeMathBuilder();
    toast('فرمول درج شد ✅');
  };
  function mtInsHtml(h){
    const el=document.getElementById('mt-canvas');
    el.focus();
    const sel=document.getSelection();
    if(!sel.rangeCount||!el.contains(sel.anchorNode)){const r=document.createRange();r.selectNodeContents(el);r.collapse(false);sel.removeAllRanges();sel.addRange(r);}
    document.execCommand('insertHTML',false,h);
  }
  window.mtInsSym=(btn)=>{mtInsHtml(btn.dataset.sym);};
  window.mtInsertFrac=()=>{mtInsHtml('<span class="mt-frac" contenteditable="false"><span class="mt-ph mt-num" contenteditable="true" data-ph="بالا"></span><span class="mt-ph mt-den" contenteditable="true" data-ph="پایین"></span></span>\u200b');};
  window.mtInsertPow=()=>{mtInsHtml('<span class="mt-pow" contenteditable="false"><span class="mt-ph" contenteditable="true" data-ph="پایه"></span><sup class="mt-ph" contenteditable="true" data-ph="n"></sup></span>\u200b');};
  window.mtInsertSub=()=>{mtInsHtml('<span class="mt-sub" contenteditable="false"><span class="mt-ph" contenteditable="true" data-ph="پایه"></span><sub class="mt-ph" contenteditable="true" data-ph="n"></sub></span>\u200b');};
  window.mtInsertRoot=()=>{mtInsHtml('<span class="mt-root" contenteditable="false"><sup class="mt-ph mt-idx" contenteditable="true" data-ph=""></sup><span class="mt-radsign">\u221a</span><span class="mt-ph mt-rad" contenteditable="true" data-ph="مقدار"></span></span>\u200b');};
  window.mtInsertBigOp=(sign)=>{mtInsHtml('<span class="mt-op" contenteditable="false"><span class="mt-op-stack"><span class="mt-ph mt-op-over" contenteditable="true" data-ph=""></span><span class="mt-op-sign">'+sign+'</span><span class="mt-ph mt-op-under" contenteditable="true" data-ph=""></span></span><span class="mt-ph mt-op-arg" contenteditable="true" data-ph="عبارت"></span></span>\u200b');};
  window.mtInsertLim=()=>{mtInsHtml('<span class="mt-lim" contenteditable="false"><span class="mt-lim-stack"><span class="mt-lim-word">lim</span><span class="mt-ph mt-lim-under" contenteditable="true" data-ph="x\u2192a"></span></span><span class="mt-ph" contenteditable="true" data-ph="عبارت"></span></span>\u200b');};
  window.mtInsertMatrix=(n)=>{
    let rows='';
    for(let r=0;r<n;r++){
      let cells='';
      for(let c=0;c<n;c++)cells+='<td class="mt-ph" contenteditable="true" data-ph="."></td>';
      rows+='<tr>'+cells+'</tr>';
    }
    mtInsHtml('<table class="mt-matrix" contenteditable="false"><tbody>'+rows+'</tbody></table>\u200b');
  };
  window.mtInsertParen=(l,r)=>{mtInsHtml('<span class="mt-paren" contenteditable="false"><span class="mt-paren-sign">'+l+'</span><span class="mt-ph" contenteditable="true" data-ph="عبارت"></span><span class="mt-paren-sign">'+r+'</span></span>\u200b');};
  window.mtInsertDiv=()=>{mtInsHtml('<table class="ldiv" contenteditable="false" dir="ltr"><tr><td class="ld-bar">&nbsp;</td><td class="ld-top mt-ph" contenteditable="true" data-ph=""></td></tr><tr><td class="ld-bar ld-divisor mt-ph" contenteditable="true" data-ph="مقسوم‌علیه"></td><td><div class="ld-dividend mt-ph" contenteditable="true" data-ph="مقسوم"></div><div class="ld-work">&nbsp;</div></td></tr></table>\u200b');};

  (function initMathBuilder(){
    const row=document.getElementById('mt-sym-row');
    if(!row)return;
    row.innerHTML=MATH.map(function(s){return '<button type="button" onmousedown="event.preventDefault()" onclick="mtInsSym(this)" data-sym="'+escA(s)+'">'+escA(s)+'</button>';}).join('');
    const canvas=document.getElementById('mt-canvas');
    if(canvas)canvas.addEventListener('input',function(){convertDigitsInElement(canvas);});
    const overlay=document.getElementById('mt-modal-overlay');
    if(overlay)overlay.addEventListener('mousedown',function(e){if(e.target===overlay)closeMathBuilder();});
  })();

  let SELSHAPE=null;
  document.addEventListener('click',function(e){
    const sh=e.target&&e.target.closest?e.target.closest('.shape'):null;
    if(sh&&sh.closest('.rich')){
      if(SELSHAPE)SELSHAPE.style.outline='';
      SELSHAPE=sh;sh.style.outline='2px solid #2563eb';
      const i=sh.closest('.rich').getAttribute('data-qd');const r=document.getElementById('ssz-'+i);
      if(r){const svg=sh.querySelector('svg');const cur=svg?parseInt(svg.getAttribute('width'),10):parseInt((sh.style.fontSize||'40'),10);if(cur)r.value=cur;}
    }else if(SELSHAPE){SELSHAPE.style.outline='';SELSHAPE=null;}
  });
  window.resizeSel=(i)=>{
    const r=document.getElementById('ssz-'+i);if(!r)return;
    if(SELSHAPE&&SELSHAPE.closest('.rich')&&SELSHAPE.closest('.rich').getAttribute('data-qd')==String(i)){
      const z=parseInt(r.value,10);const svg=SELSHAPE.querySelector('svg');
      if(svg){svg.setAttribute('width',z);svg.setAttribute('height',z);}else{SELSHAPE.style.fontSize=z+'px';}
      updHtml(i);
    }
  };
  window.loadImg=(i,input)=>{
    const f=input.files[0];if(!f)return;
    const rd=new FileReader();
    rd.onload=ev=>{
      const img=new Image();
      img.onload=()=>{
        const c=document.createElement('canvas');const mw=1600;let w=img.width,h=img.height;
        if(w>mw){h=Math.round(h*mw/w);w=mw;}
        c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);
        QUESTIONS[i].image=c.toDataURL('image/jpeg',0.92);
        if(QUESTIONS[i].imageAsQuestion && !QUESTIONS[i].imageWidth){QUESTIONS[i].imageWidth=500;}
        renderQ();
      };img.src=ev.target.result;
    };rd.readAsDataURL(f);
  };
  window.rmImg=(i)=>{QUESTIONS[i].image='';QUESTIONS[i].imageWidth=0;renderQ();};
  window.updImgSize=(i,val)=>{QUESTIONS[i].imageWidth=parseInt(val,10)||320;renderQ();};
  window.toggleQImageMode=(i,checked)=>{
    QUESTIONS[i].imageAsQuestion=checked;
    renderQ();
  };
  
  document.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>{
    const t=b.dataset.add;
    QUESTIONS.push({
      id: uid(),
      type: t,
      rich: t==='descriptive',
      text: '',
      options: t==='multiple' ? ['','','',''] : [],
      correct: t==='multiple' ? '0' : (t==='truefalse' ? 'true' : ''),
      image: '',
      weight: 1
    });
    renderQ();
  });
  
  document.getElementById('btn-save-q').onclick=async()=>{
    const duration = parseInt(document.getElementById('m-exam-duration').value);
    if(isNaN(duration) || duration < 1){
      toast('❌ مدت زمان باید حداقل ۱ دقیقه باشد');
      return;
    }
    
    // بررسی جمع وزن‌ها
    const totalWeight = calculateTotalWeight();
    if (Math.abs(totalWeight - 20) > 0.01) {
      if (!confirm('⚠️ جمع وزن‌های سوالات ' + totalWeight.toFixed(1) + ' است (باید 20 باشد). آیا مطمئن هستید؟')) {
        return;
      }
    }
    
    META={
      school: document.getElementById('m-school').value,
      teacher: document.getElementById('m-teacher').value,
      examName: document.getElementById('m-exam-name').value,
      examDuration: String(duration),
      gradeLevel: document.getElementById('m-grade-level').value
    };
    const d=await api('/api/teacher/questions',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({questions:QUESTIONS,meta:META})});
    if(d.ok){toast('سربرگ و سوالات ذخیره شد ✅');}else toast(d.error||'خطا');
  };

  // ===== پاسخنامه‌ها =====
  function ansText(q,ans){
    if(q.type==='multiple'){const idx=parseInt(ans,10);return isNaN(idx)?'':(['الف','ب','ج','د'][idx]+') '+esc((q.options&&q.options[idx])||''));}
    if(q.type==='truefalse'){return ans==='true'?'صحیح':(ans==='false'?'غلط':'');}
    return esc(ans);
  }
  
  let GRADING_TYPE = 'descriptive';
  
  document.querySelectorAll('input[name="grading-type"]').forEach(radio => {
    radio.onchange = function() {
      GRADING_TYPE = this.value;
      const sel=document.getElementById('ans-student-select');
      if(sel.value)renderAnswerDetail(sel.value);
    };
  });
  
  window.openAnsPhoto=function(src){
    document.getElementById('ans-photo-modal-img').src=src;
    document.getElementById('ans-photo-modal-dl').href=src;
    document.getElementById('ans-photo-modal').classList.remove('hidden');
  };
  window.closeAnsPhoto=function(){
    document.getElementById('ans-photo-modal').classList.add('hidden');
  };

  async function loadAnswers(){
    const d=await api('/api/teacher/submissions');
    SUBS=d.submissions||[];
    const sel=document.getElementById('ans-student-select');
    const box=document.getElementById('answers-list');
    if(!SUBS.length){
      sel.innerHTML='<option value="">— پاسخنامه‌ای ثبت نشده —</option>';
      box.innerHTML='<p class="muted">هنوز پاسخنامه‌ای ثبت نشده است.</p>';
      return;
    }
    const prevVal=sel.value;
    sel.innerHTML='<option value="">— یک دانش‌آموز را انتخاب کنید —</option>'+SUBS.map(function(s){
      const g=s.grading||{graded:false};
      const status=g.graded?' ✅ تصحیح‌شده':' ⏳ در انتظار تصحیح';
      return '<option value="'+s.uuid+'">'+esc(s.student.name)+status+'</option>';
    }).join('');
    if(prevVal && SUBS.some(function(s){return s.uuid===prevVal;})){
      sel.value=prevVal;
      renderAnswerDetail(prevVal);
    }else{
      box.innerHTML='<p class="muted">یک دانش‌آموز را از فهرست بالا انتخاب کنید تا پاسخنامه‌ی او نمایش داده شود.</p>';
    }
  }

  function renderAnswerDetail(uuid){
    const box=document.getElementById('answers-list');
    const s=SUBS.find(function(x){return x.uuid===uuid;});
    if(!s){box.innerHTML='';return;}
    const g=s.grading||{graded:false,feedback:{},marks:{},overall:''};
    const isNumeric = GRADING_TYPE === 'numeric';
    const rows=(s.questionsSnapshot||[]).map((q,i)=>{
      const ans=s.answers?s.answers[q.id]:'';
      const photoAns=s.photoAnswers?s.photoAnswers[q.id]:'';
      const fb=(g.feedback&&g.feedback[q.id])||'';
      const mk=(g.marks&&g.marks[q.id])||'';
      const weight = q.weight || 1;
      
      let gradeCell;
      if(isNumeric){
        // محاسبه حداکثر نمره برای این سوال (بر اساس وزن)
        const totalWeight = s.questionsSnapshot.reduce((sum, qq) => sum + (qq.weight || 1), 0) || 20;
        const maxScore = (weight / totalWeight) * 20;
        gradeCell='<input type="number" id="mk_'+s.uuid+'_'+q.id+'" value="'+esc(mk)+'" placeholder="نمره" min="0" max="'+maxScore.toFixed(1)+'" step="0.5" style="width:80px;padding:6px;border:1px solid #ddd;border-radius:4px">'+
          '<span style="font-size:11px;color:#64748b;margin-right:4px">از '+maxScore.toFixed(1)+'</span>';
      } else {
        const opt=(v,t)=>'<option value="'+v+'" '+(mk===v?'selected':'')+'>'+t+'</option>';
        gradeCell='<select id="mk_'+s.uuid+'_'+q.id+'"><option value="">—</option>'+opt('excellent','🌟 خیلی خوب')+opt('good','✅ خوب')+opt('acceptable','📌 قابل‌قبول')+opt('needs-improve','📖 نیاز به تلاش')+'</select>';
      }
      
      return '<tr><td>'+(i+1)+'</td><td>'+qHtml(q)+(q.image?'<br><img src="'+q.image+'" class="imgprev" style="max-width:'+(q.imageWidth||320)+'px;width:100%;cursor:zoom-in" onclick="openAnsPhoto(this.src)" title="برای بزرگ‌نمایی کلیک کنید">':'')+'</td>'+
        '<td>'+(ansText(q,ans)||(photoAns?'':'<i>بدون پاسخ</i>'))+(photoAns?'<br><img src="'+photoAns+'" class="ans-photo-thumb" onclick="openAnsPhoto(this.src)" style="max-width:200px;width:100%;border:1px solid #ddd;border-radius:6px;margin-top:6px;cursor:zoom-in" title="برای بزرگ‌نمایی کلیک کنید"><br><a href="'+photoAns+'" download="پاسخ.jpg" class="btn sm secondary" style="margin-top:4px;display:inline-block">⬇️ دانلود عکس</a>':'')+'</td>'+
        '<td>'+gradeCell+'</td>'+
        '<td><input type="text" id="fb_'+s.uuid+'_'+q.id+'" value="'+esc(fb)+'" placeholder="بازخورد"></td></tr>';
    }).join('');
    const badge=g.graded?'<span class="pill ok">✅ تصحیح‌شده</span>':'<span class="pill gr">⏳ در انتظار تصحیح</span>';
    
    const statusHeader = isNumeric ? 'نمره' : 'وضعیت';
    const feedbackLabel = isNumeric ? 'توضیحات (اختیاری)' : 'بازخورد';
    const avatar=s.studentPhoto?'<img src="'+s.studentPhoto+'" style="width:44px;height:44px;border-radius:50%;object-fit:cover">':'<div style="width:44px;height:44px;border-radius:50%;background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:20px">🧑‍🎓</div>';
    
    box.innerHTML='<div class="q-block"><div class="qhead"><span style="display:flex;align-items:center;gap:8px">'+avatar+'<b>'+esc(s.student.name)+'</b> '+badge+'</span>'+
      ' <a class="btn sm sec" href="/api/teacher/word?type=answers&uuid='+s.uuid+'">📄 دانلود Word</a></div>'+
      '<p class="muted">نام پدر: '+esc(s.student.fatherName)+' | کد ملی: '+esc(s.student.nationalId)+' | نام درس: '+esc(s.student.courseName||'')+' | تاریخ آزمون: '+esc(s.student.examDate||'')+' | ثبت: '+new Date(s.submittedAt).toLocaleString('fa-IR')+'</p>'+
      '<table><tr><th>#</th><th>سوال</th><th>پاسخ دانش‌آموز</th><th>'+statusHeader+'</th><th>'+feedbackLabel+'</th></tr>'+rows+'</table>'+
      '<label>'+feedbackLabel+' کلی</label><textarea id="ov_'+s.uuid+'">'+esc(g.overall||'')+'</textarea>'+
      '<button class="btn" style="margin-top:8px" onclick="saveGrade(\\''+s.uuid+'\\')">ثبت تصحیح</button></div>';
  }

  document.getElementById('ans-student-select').addEventListener('change', function(){
    if(this.value)renderAnswerDetail(this.value);
    else document.getElementById('answers-list').innerHTML='<p class="muted">یک دانش‌آموز را از فهرست بالا انتخاب کنید تا پاسخنامه‌ی او نمایش داده شود.</p>';
  });

  window.saveGrade=async(uuid)=>{
    const sub=SUBS.find(x=>x.uuid===uuid);if(!sub)return;
    const feedback={},marks={};
    (sub.questionsSnapshot||[]).forEach(q=>{
      const fb=document.getElementById('fb_'+uuid+'_'+q.id);const mk=document.getElementById('mk_'+uuid+'_'+q.id);
      if(fb)feedback[q.id]=fb.value;
      if(mk&&mk.value)marks[q.id]=mk.value;
    });
    const overall=document.getElementById('ov_'+uuid).value;
    const d=await api('/api/teacher/grade',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({uuid,feedback,marks,overall})});
    if(d.ok){toast('تصحیح ثبت شد ✅');loadAnswers();}else toast(d.error||'خطا');
  };
  document.getElementById('btn-refresh-ans').onclick=loadAnswers;

  // ===== کاربرگ =====
  let WORKSHEET_STUDENTS=[];
  async function loadWorksheetList(){
    const sel=document.getElementById('ws-student-select');
    const box=document.getElementById('worksheet-list');
    const d=await api('/api/teacher/students');
    if(!d.ok||!d.students||!d.students.length){
      sel.innerHTML='<option value="">— ابتدا دانش‌آموز بسازید —</option>';
      box.innerHTML='<p class="muted">ابتدا از تب «دانش‌آموزان» یک دانش‌آموز بسازید.</p>';
      return;
    }
    WORKSHEET_STUDENTS=d.students;
    const prevVal=sel.value;
    sel.innerHTML='<option value="">— یک دانش‌آموز را انتخاب کنید —</option>'+d.students.map(function(s){
      return '<option value="'+s.uuid+'">'+esc(s.label||'(بدون نام)')+'</option>';
    }).join('');
    if(prevVal && d.students.some(function(s){return s.uuid===prevVal;})){
      sel.value=prevVal;
      renderWorksheetDetail(prevVal);
    }else{
      box.innerHTML='<p class="muted">یک دانش‌آموز را از فهرست بالا انتخاب کنید.</p>';
    }
  }
  document.getElementById('btn-refresh-ws').onclick=loadWorksheetList;

  async function renderWorksheetDetail(uuid){
    const box=document.getElementById('worksheet-list');
    const s=WORKSHEET_STUDENTS.find(function(x){return x.uuid===uuid;});
    const avatar=(s&&s.photo)?'<img src="'+s.photo+'" style="width:40px;height:40px;border-radius:50%;object-fit:cover">':'<div style="width:40px;height:40px;border-radius:50%;background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:18px">🧑‍🎓</div>';
    box.innerHTML='<div class="q-block" id="ws-row-'+uuid+'">'+
      '<div class="row" style="align-items:center;flex-wrap:wrap">'+
        '<span style="display:flex;align-items:center;gap:8px;flex:1">'+avatar+'<b>'+esc(s?s.label:'')+'</b></span>'+
        '<label class="btn sm sec" style="cursor:pointer;flex:0 0 auto">📄 بارگذاری/جایگزینی کاربرگ<input type="file" accept="image/*,application/pdf" class="hidden" data-ws-upload="'+uuid+'"></label>'+
      '</div>'+
      '<div id="ws-detail-'+uuid+'" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)"><p class="muted">در حال بارگذاری...</p></div>'+
    '</div>';
    const detail=document.getElementById('ws-detail-'+uuid);
    const d=await api('/api/teacher/worksheet/'+uuid);
    if(!d.ok){detail.innerHTML='<p class="muted">خطا در بارگذاری</p>';return;}
    const w=d.worksheet||{};
    let html='';
    if(w.teacherFile){
      html+='<div style="margin-bottom:12px"><b style="font-size:13px">📄 کاربرگ ارسال‌شده:</b><br>';
      if(w.teacherFileType==='pdf'){
        html+='<a class="btn sm sec" href="'+w.teacherFile+'" download="'+(w.teacherFileName||'کاربرگ.pdf')+'" style="margin-top:6px;display:inline-block">⬇️ دانلود PDF ('+esc(w.teacherFileName||'')+')</a>';
      }else{
        html+='<img src="'+w.teacherFile+'" style="max-width:260px;border-radius:8px;border:1px solid #ddd;margin-top:6px;display:block;cursor:zoom-in" onclick="openAnsPhoto(this.src)" title="برای بزرگ‌نمایی کلیک کنید">';
      }
      html+='<button class="btn sm danger" type="button" style="margin-top:6px" data-ws-remove="'+uuid+'">🗑 حذف کاربرگ</button>';
      html+='</div>';
    }else{
      html+='<p class="muted">هنوز کاربرگی برای این دانش‌آموز بارگذاری نکرده‌اید.</p>';
    }
    if(w.studentFiles&&w.studentFiles.length){
      html+='<div style="margin-bottom:12px"><b style="font-size:13px">📷 عکس‌های ارسالی دانش‌آموز:</b><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">'+
        w.studentFiles.map(function(p){return '<img src="'+p+'" style="width:100px;height:100px;object-fit:cover;border-radius:8px;border:1px solid #ddd;cursor:pointer" onclick="openAnsPhoto(this.src)">';}).join('')+
      '</div></div>';
    }else{
      html+='<p class="muted">دانش‌آموز هنوز کاربرگ انجام‌شده را ارسال نکرده است.</p>';
    }
    html+='<div><label style="font-weight:600;font-size:13px">💬 بازخورد شما:</label>'+
      '<textarea id="ws-fb-'+uuid+'" placeholder="بازخورد خود را برای دانش‌آموز بنویسید...">'+esc(w.feedback||'')+'</textarea>'+
      '<button class="btn sm primary" style="margin-top:8px" data-ws-savefb="'+uuid+'">💾 ذخیره بازخورد</button></div>';
    detail.innerHTML=html;
  }

  document.getElementById('ws-student-select').addEventListener('change', function(){
    if(this.value)renderWorksheetDetail(this.value);
    else document.getElementById('worksheet-list').innerHTML='<p class="muted">یک دانش‌آموز را از فهرست بالا انتخاب کنید.</p>';
  });

  document.getElementById('worksheet-list').addEventListener('change',async function(e){
    const inp=e.target.closest('[data-ws-upload]');
    if(!inp)return;
    const uuid=inp.dataset.wsUpload;
    const file=inp.files&&inp.files[0];
    inp.value='';
    if(!file)return;
    try{
      let fileDataUrl,fileName;
      if(file.type==='application/pdf'){
        if(file.size>4*1024*1024){toast('حجم فایل PDF باید کمتر از ۴ مگابایت باشد');return;}
        fileDataUrl=await new Promise(function(resolve,reject){
          const rd=new FileReader();
          rd.onload=function(){resolve(rd.result);};
          rd.onerror=function(){reject(new Error('خطا در خواندن فایل'));};
          rd.readAsDataURL(file);
        });
        fileName=file.name;
      }else if(file.type.startsWith('image/')){
        fileDataUrl=await compressWorksheetImage(file);
        fileName=file.name;
      }else{
        toast('فقط فایل عکس یا PDF مجاز است');return;
      }
      toast('در حال بارگذاری کاربرگ...');
      const d=await api('/api/teacher/worksheet/'+uuid,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fileDataUrl,fileName})});
      if(d.ok){toast('کاربرگ بارگذاری شد ✅');renderWorksheetDetail(uuid);}else toast(d.error||'خطا در بارگذاری');
    }catch(err){toast(err.message||'خطا در پردازش فایل');}
  });

  document.getElementById('worksheet-list').addEventListener('click',async function(e){
    const btn=e.target.closest('[data-ws-savefb]');
    if(!btn)return;
    const uuid=btn.dataset.wsSavefb;
    const ta=document.getElementById('ws-fb-'+uuid);
    const feedback=ta?ta.value:'';
    const d=await api('/api/teacher/worksheet/'+uuid+'/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({feedback})});
    if(d.ok)toast('بازخورد ذخیره شد ✅');else toast(d.error||'خطا در ذخیره بازخورد');
  });

  document.getElementById('worksheet-list').addEventListener('click',async function(e){
    const btn=e.target.closest('[data-ws-remove]');
    if(!btn)return;
    const uuid=btn.dataset.wsRemove;
    if(!confirm('آیا از حذف کاربرگ مطمئن هستید؟'))return;
    const d=await api('/api/teacher/worksheet/'+uuid,{method:'DELETE'});
    if(d.ok){toast('کاربرگ حذف شد ✅');renderWorksheetDetail(uuid);}else toast(d.error||'خطا در حذف');
  });

  // ===== برنامه هفتگی =====
  async function loadSchedule(){
    const r=await api('/api/teacher/schedule');
    if(r.ok && r.data){
      scheduleData=r.data;
      document.getElementById('sch-school').value=scheduleData.school||'';
      document.getElementById('sch-year').value=scheduleData.year||'';
      document.getElementById('sch-topic').value=scheduleData.topic||'';
      document.getElementById('sch-principal').value=scheduleData.principal||'';
      document.getElementById('sch-class').value=scheduleData.cls||'';
      document.getElementById('sch-teacher').value=scheduleData.teacher||'';
      if(scheduleData.cells){
        for(let d=0;d<5;d++){for(let i=1;i<=5;i++){const el=document.getElementById('c'+d+i);if(el)el.value=scheduleData.cells['c'+d+i]||'';}}
      }
    }
  }

  // ===== سوییچ تم رنگی برنامهٔ هفتگی (پسرانه/دخترانه/پیش‌فرض) =====
  document.querySelectorAll('.sch-theme-btn').forEach(btn=>{
    btn.onclick=()=>{
      document.querySelectorAll('.sch-theme-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const wrap=document.getElementById('schedule-table-wrap');
      wrap.classList.remove('theme-boy','theme-girl');
      if(btn.dataset.theme==='boy')wrap.classList.add('theme-boy');
      if(btn.dataset.theme==='girl')wrap.classList.add('theme-girl');
      lbSave('sch-theme',btn.dataset.theme,true);
    };
  });
  let SCH_THEME_LOADED=false;
  async function loadScheduleThemeIfNeeded(){
    if(SCH_THEME_LOADED)return;
    SCH_THEME_LOADED=true;
    const saved=await lbLoad('sch-theme');
    if(saved && saved!=='default'){
      const btn=document.querySelector('.sch-theme-btn[data-theme="'+saved+'"]');
      if(btn)btn.click();
    }
  }

  document.getElementById('btn-gen-schedule').onclick=function(){
    const body=document.getElementById('schedule-body');
    let html='';
    const days=['شنبه','یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه'];
    const dayKeys=['shanbe','yekshanbe','doshshanbe','seshshanbe','chaharshanbe'];
    // نگاشت روز هفته‌ی جاری (جاوااسکریپت) به ایندکس ردیف برنامه (شنبه=0 ... چهارشنبه=4)
    const jsDayToRow={6:0,0:1,1:2,2:3,3:4};
    const todayRow=jsDayToRow.hasOwnProperty(new Date().getDay())?jsDayToRow[new Date().getDay()]:-1;
    for(let d=0;d<5;d++){
      const isToday=d===todayRow;
      html+='<tr'+(isToday?' class="sch-today"':'')+'><td class="sch-daylabel-'+dayKeys[d]+'"><span class="sch-day-accent"></span>'+(isToday?'<span class="sch-today-badge">امروز</span>':'')+days[d]+'</td>';
      for(let i=1;i<=5;i++){
        const val=(scheduleData.cells&&scheduleData.cells['c'+d+i])||'';
        html+='<td class="cell-'+dayKeys[d]+'"><textarea id="c'+d+i+'" placeholder="زنگ '+(i)+'">'+esc(val)+'</textarea></td>';
      }
      html+='</tr>';
    }
    body.innerHTML=html;
  };

  function getScheduleHtmlForExport(){
    const school=document.getElementById('sch-school').value||'مدرسه';
    const year=document.getElementById('sch-year').value||'';
    const cls=document.getElementById('sch-class').value||'';
    const teacher=document.getElementById('sch-teacher').value||'';
    const days=['شنبه','یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه'];
    const zang=['زنگ اول','زنگ دوم','زنگ سوم','زنگ چهارم','زنگ پنجم'];
    const accentColors=['#ef4444','#f59e0b','#10b981','#8b5cf6','#06b6d4'];
    const cellColors=['#fef2f2','#fffbeb','#f0fdf4','#f5f3ff','#ecfeff'];
    let style='<style>@font-face{font-family:"BNazanin";src:url(https://cdn.jsdelivr.net/gh/naderuser/bnazanin@main/BNazanin.ttf)}';
    style+='body{direction:rtl;font-family:"BNazanin",tahoma,Arial;padding:30px;background:#f8fafc}';
    style+='.header{text-align:center;padding:20px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border-radius:20px;margin-bottom:20px}';
    style+='.header h1{font-size:24px;margin:0 0 10px;font-weight:800;letter-spacing:.3px}.header p{margin:5px 0;font-size:14px}';
    style+='table{width:100%;border-collapse:collapse;box-shadow:0 8px 24px rgba(15,23,42,.10);border:1.5px solid #1e293b}';
    style+='th{padding:14px 8px;font-size:14px;font-weight:800;text-align:center;border:1px solid #1e293b}';
    style+='td{padding:14px 10px;text-align:center;font-size:13px;min-height:50px;font-weight:600;color:#1e293b;border:1px solid #1e293b}';
    style+='.daylabel{border-right:5px solid;font-weight:800}';
    style+='.footer{text-align:center;margin-top:30px;padding:20px;border-top:2px dashed #ddd}</style>';
    let header='<div class="header"><h1>⭐ برنامه هفتگی کلاس ⭐</h1><p>🏫 '+esc(school)+' | سال تحصیلی: '+esc(year)+'</p><p>کلاس: '+esc(cls)+' | آموزگار: '+esc(teacher)+'</p></div>';
    let table='<table><tr><th style="background:linear-gradient(135deg,#1e293b,#334155);color:#fff;border-bottom:none">روز / زنگ</th>';
    for(let z=0;z<5;z++){table+='<th style="background:#f8fafc;color:#334155">🔔 '+zang[z]+'</th>';}
    table+='</tr>';
    for(let d=0;d<5;d++){
      table+='<tr><td class="daylabel" style="background:'+cellColors[d]+';border-right-color:'+accentColors[d]+'">'+days[d]+'</td>';
      for(let i=1;i<=5;i++){const el=document.getElementById('c'+d+i);const val=(el?el.value:'')||'&nbsp;';table+='<td style="background:'+cellColors[d]+'"><div style="min-height:40px">'+val+'</div></td>';}
      table+='</tr>';
    }
    table+='</table>';
    const footer='';
    return '<html><head><meta charset="utf-8">'+style+'</head><body>'+header+table+footer+'</body></html>';
  }

  document.getElementById('btn-print-schedule').onclick=function(){const w=window.open('','_blank');w.document.write(getScheduleHtmlForExport());w.document.close();setTimeout(function(){w.print();},500);};
  document.getElementById('btn-word-schedule').onclick=function(){const blob=new Blob([getScheduleHtmlForExport()],{type:'application/msword'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='برنامه-هفتگی.doc';document.body.appendChild(a);a.click();a.remove();};
  document.getElementById('btn-pdf-schedule').onclick=function(){const w=window.open('','_blank');w.document.write(getScheduleHtmlForExport());w.document.close();setTimeout(function(){w.print();},500);};
  
  document.getElementById('btn-save-schedule').onclick=async function(){
    const data={school:document.getElementById('sch-school').value,year:document.getElementById('sch-year').value,topic:document.getElementById('sch-topic').value,principal:document.getElementById('sch-principal').value,cls:document.getElementById('sch-class').value,teacher:document.getElementById('sch-teacher').value,cells:{}};
    for(let d=0;d<5;d++){for(let i=1;i<=5;i++){const el=document.getElementById('c'+d+i);if(el)data.cells['c'+d+i]=el.value;}}
    const r=await api('/api/teacher/schedule',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({data})});
    if(r.ok)toast('برنامه هفتگی ذخیره شد ✅');else toast('خطا در ذخیره');
  };

  // ===== جدول‌ساز حرفه‌ای (شبیه اکسل واقعی) =====
  function colLetter(n){ // 1 -> A, 2 -> B ... 27 -> AA
    let s='';
    while(n>0){ const m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=Math.floor((n-1)/26); }
    return s;
  }
  function xlsCellId(r,c){return 't'+r+'_'+c;}
  function xlsTitleId(c){return 'ht_'+c;}

  document.getElementById('btn-gen-table').onclick=function(){
    const rows=parseInt(document.getElementById('tbl-rows').value)||5;
    const cols=parseInt(document.getElementById('tbl-cols').value)||4;
    xlsBuildStructure(rows,cols);
    if(document.getElementById('tbl-avg-check').checked)calcAndShowAvg();
  };

  // ساخت کامل ساختار جدول (هدر + بدنه‌ی خالی) با تعداد سطر/ستون داده‌شده — این تابع همه‌چیز را از نو می‌سازد
  function xlsBuildStructure(rows,cols){
    const thead=document.getElementById('custom-table-head');
    const tbody=document.getElementById('custom-table-body');
    const tfoot=document.getElementById('custom-table-foot');

    let ch='<tr><th class="xls-corner"></th>';
    for(let c=1;c<=cols;c++){ch+='<th class="xls-colhead">'+colLetter(c)+'</th>';}
    ch+='<th class="xls-corner" rowspan="2">حذف</th>';
    ch+='</tr>';
    ch+='<tr class="xls-titlerow"><th class="xls-rowhead">#</th>';
    for(let c=1;c<=cols;c++){
      ch+='<th><div style="display:flex;align-items:center;gap:4px">'+
        '<input type="text" id="'+xlsTitleId(c)+'" placeholder="عنوان ستون '+c+'" value="ستون '+c+'" style="flex:1;min-width:0">'+
        '<button type="button" class="btn sm danger xls-col-del" data-col="'+c+'" title="حذف این ستون" style="padding:2px 6px;flex:0 0 auto">✖</button>'+
        '</div></th>';
    }
    ch+='</tr>';
    thead.innerHTML=ch;

    let b='';
    for(let r=1;r<=rows;r++){
      b+='<tr><td class="xls-rowhead">'+r+'</td>';
      for(let c=1;c<=cols;c++){b+='<td><input type="text" id="'+xlsCellId(r,c)+'" data-r="'+r+'" data-c="'+c+'"></td>';}
      b+='<td class="org-row-del-cell"><button type="button" class="btn sm danger xls-row-del">✖</button></td>';
      b+='</tr>';
    }
    tbody.innerHTML=b;
    tfoot.innerHTML='';
  }

  // افزودن یک سطر تازه به انتهای جدول موجود، بدون پاک‌کردن مقادیر سطرهای قبلی
  function xlsAddRow(){
    const tbody=document.getElementById('custom-table-body');
    const cols=parseInt(document.getElementById('tbl-cols').value)||4;
    if(!tbody.children.length){toast('ابتدا با دکمه‌ی «ساخت جدول» یک جدول بسازید');return;}
    const r=tbody.children.length+1;
    const tr=document.createElement('tr');
    let rowHtml='<td class="xls-rowhead">'+r+'</td>';
    for(let c=1;c<=cols;c++){rowHtml+='<td><input type="text" id="'+xlsCellId(r,c)+'" data-r="'+r+'" data-c="'+c+'"></td>';}
    rowHtml+='<td class="org-row-del-cell"><button type="button" class="btn sm danger xls-row-del">✖</button></td>';
    tr.innerHTML=rowHtml;
    tbody.appendChild(tr);
    document.getElementById('tbl-rows').value=r;
    if(document.getElementById('tbl-avg-check').checked)calcAndShowAvg();
  }
  document.getElementById('btn-tbl-add-row').onclick=xlsAddRow;

  // حذف یک ستون (بدون از دست رفتن مقادیر بقیه‌ی ستون‌ها و سطرها)
  function xlsDeleteColumn(colIdx){
    const cols=parseInt(document.getElementById('tbl-cols').value)||4;
    if(cols<=1){toast('حداقل باید یک ستون باقی بماند');return;}
    const rows=parseInt(document.getElementById('tbl-rows').value)||5;
    const titles=[];
    for(let c=1;c<=cols;c++){
      if(c===colIdx)continue;
      const el=document.getElementById(xlsTitleId(c));
      titles.push(el?el.value:'ستون '+c);
    }
    const data=[];
    for(let r=1;r<=rows;r++){
      const rowVals=[];
      for(let c=1;c<=cols;c++){
        if(c===colIdx)continue;
        const el=document.getElementById(xlsCellId(r,c));
        rowVals.push(el?el.value:'');
      }
      data.push(rowVals);
    }
    const newCols=cols-1;
    document.getElementById('tbl-cols').value=newCols;
    xlsBuildStructure(rows,newCols);
    for(let c=1;c<=newCols;c++){
      const el=document.getElementById(xlsTitleId(c));
      if(el)el.value=titles[c-1]!==undefined?titles[c-1]:('ستون '+c);
    }
    for(let r=1;r<=rows;r++){
      for(let c=1;c<=newCols;c++){
        const el=document.getElementById(xlsCellId(r,c));
        if(el)el.value=data[r-1][c-1]||'';
      }
    }
    if(document.getElementById('tbl-avg-check').checked)calcAndShowAvg();
    toast('ستون حذف شد ✅');
  }
  document.getElementById('custom-table-head').addEventListener('click',function(e){
    const btn=e.target.closest('.xls-col-del');
    if(!btn)return;
    xlsDeleteColumn(parseInt(btn.dataset.col,10));
  });

  function xlsDeleteRow(tr){
    const tbody=document.getElementById('custom-table-body');
    if(tbody.children.length<=1){toast('حداقل باید یک سطر باقی بماند');return;}
    const cols=parseInt(document.getElementById('tbl-cols').value)||4;
    tr.remove();
    const trs=Array.from(tbody.children);
    trs.forEach((row,idx)=>{
      const r=idx+1;
      row.children[0].textContent=r;
      for(let c=1;c<=cols;c++){
        const cell=row.children[c];
        const input=cell?cell.querySelector('input'):null;
        if(input){input.id=xlsCellId(r,c);input.dataset.r=r;input.dataset.c=c;}
      }
    });
    document.getElementById('tbl-rows').value=trs.length;
    if(document.getElementById('tbl-avg-check').checked)calcAndShowAvg();
  }
  document.getElementById('custom-table-body').addEventListener('click',function(e){
    const btn=e.target.closest('.xls-row-del');
    if(!btn)return;
    xlsDeleteRow(btn.closest('tr'));
  });

  function calcAndShowAvg(){
    const rows=parseInt(document.getElementById('tbl-rows').value)||5;
    const cols=parseInt(document.getElementById('tbl-cols').value)||4;
    const tfoot=document.getElementById('custom-table-foot');
    if(!document.getElementById(xlsCellId(1,1))){ tfoot.innerHTML=''; return; } // جدولی هنوز ساخته نشده
    const avgCells=[];
    for(let c=1;c<=cols;c++){
      const vals=[];for(let r=1;r<=rows;r++){const el=document.getElementById(xlsCellId(r,c));const v=parseFloat(el?el.value.trim():'');if(!isNaN(v))vals.push(v);}
      avgCells.push(vals.length>0?(vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(2):'—');
    }
    let f='<tr class="xls-avgrow"><td>📈</td>';
    for(let c=1;c<=cols;c++){f+='<td>'+avgCells[c-1]+'</td>';}
    f+='</tr>';tfoot.innerHTML=f;
  }

  // ===== ذخیره/بارگذاری جدول‌ساز =====
  document.getElementById('btn-save-table').onclick=async function(){
    const rows=parseInt(document.getElementById('tbl-rows').value)||5;
    const cols=parseInt(document.getElementById('tbl-cols').value)||4;
    if(!document.getElementById(xlsCellId(1,1))){toast('ابتدا جدول را بسازید');return;}
    const titles=[];
    for(let c=1;c<=cols;c++){const el=document.getElementById(xlsTitleId(c));titles.push(el?el.value:'');}
    const cells=[];
    for(let r=1;r<=rows;r++){
      const rowVals=[];
      for(let c=1;c<=cols;c++){const el=document.getElementById(xlsCellId(r,c));rowVals.push(el?el.value:'');}
      cells.push(rowVals);
    }
    await lbSave('customtable',{rows,cols,title:document.getElementById('tbl-title').value,avgCheck:document.getElementById('tbl-avg-check').checked,titles,cells});
  };

  let TABLE_LOADED=false;
  async function loadTableIfNeeded(){
    if(TABLE_LOADED)return;
    TABLE_LOADED=true;
    const saved=await lbLoad('customtable');
    if(!saved)return;
    document.getElementById('tbl-rows').value=saved.rows||5;
    document.getElementById('tbl-cols').value=saved.cols||4;
    document.getElementById('tbl-title').value=saved.title||'';
    document.getElementById('tbl-avg-check').checked=saved.avgCheck!==false;
    document.getElementById('btn-gen-table').click();
    (saved.titles||[]).forEach((t,idx)=>{const el=document.getElementById(xlsTitleId(idx+1));if(el)el.value=t;});
    (saved.cells||[]).forEach((rowVals,ri)=>{
      rowVals.forEach((v,ci)=>{const el=document.getElementById(xlsCellId(ri+1,ci+1));if(el)el.value=v;});
    });
    if(document.getElementById('tbl-avg-check').checked)calcAndShowAvg();
  }

  // ===== وارد کردن جدول از فایل PDF (با تشخیص خطوط واقعی جدول، مثل بخش PDF به Word) =====
  document.getElementById('btn-tbl-import-pdf').onclick=()=>{document.getElementById('tbl-pdf-file').click();};
  document.getElementById('tbl-pdf-file').addEventListener('change',async function(e){
    const file=e.target.files[0];
    if(!file)return;
    const statusEl=document.getElementById('tbl-pdf-status');
    statusEl.textContent='در حال خواندن فایل PDF...';
    ocrFixCount=0;ocrFailCount=0;
    try{
      const buf=await file.arrayBuffer();
      const doc=await pdfjsLib.getDocument({data:buf}).promise;
      let allRows=[];
      for(let p=1;p<=doc.numPages;p++){
        statusEl.textContent='در حال استخراج جدول از صفحه '+p+' از '+doc.numPages+'... (اگر فونت PDF غیراستاندارد باشد، تشخیص متن با OCR کمی بیشتر طول می‌کشد)';
        const blocks=await extractPdfPageBlocks(p,doc);
        blocks.forEach(block=>{
          if(block.type==='table'){
            block.rows.forEach(cells=>{
              allRows.push(cells.map(cellLines=>cellLines.join(' ')));
            });
          }
        });
      }
      if(allRows.length===0){
        statusEl.textContent='';
        toast('هیچ جدول واقعی (با خط‌کشی) در این PDF پیدا نشد');
        e.target.value='';
        return;
      }
      const maxCols=Math.max(...allRows.map(r=>r.length));
      document.getElementById('tbl-rows').value=allRows.length;
      document.getElementById('tbl-cols').value=maxCols;
      document.getElementById('btn-gen-table').click();
      allRows.forEach((rowArr,ri)=>{
        rowArr.forEach((val,ci)=>{
          const cell=document.getElementById(xlsCellId(ri+1,ci+1));
          if(cell)cell.value=val;
        });
      });
      if(document.getElementById('tbl-avg-check').checked)calcAndShowAvg();
      statusEl.textContent='';
      let msg='جدول با '+allRows.length+' ردیف از PDF وارد شد ✅';
      if(ocrFixCount>0)msg+=' ('+ocrFixCount+' سلول با فونت خراب توسط OCR ترمیم شد';
      if(ocrFailCount>0)msg+=(ocrFixCount>0?'، ':' (')+ocrFailCount+' سلول هنوز نیاز به اصلاح دستی دارد';
      if(ocrFixCount>0||ocrFailCount>0)msg+=')';
      toast(msg);
    }catch(err){
      statusEl.textContent='';
      toast('خطا در خواندن یا تحلیل فایل PDF');
    }
    e.target.value='';
  });
  document.getElementById('tbl-avg-check').onchange=function(){this.checked?calcAndShowAvg():document.getElementById('custom-table-foot').innerHTML='';};
  // محاسبه‌ی زنده‌ی میانگین با هر بار تایپ در سلول‌های عددی
  document.getElementById('custom-table-body').addEventListener('input',function(e){
    if(e.target && e.target.tagName==='INPUT' && document.getElementById('tbl-avg-check').checked) calcAndShowAvg();
  });

  // در صورت نیاز، بدون پاک‌کردن داده‌های موجود، ردیف‌های بیشتری به جدول اضافه می‌کند
  function xlsEnsureRows(newRowCount){
    const rowsInput=document.getElementById('tbl-rows');
    const currentRows=parseInt(rowsInput.value)||0;
    if(newRowCount<=currentRows)return;
    const cols=parseInt(document.getElementById('tbl-cols').value)||4;
    const tbody=document.getElementById('custom-table-body');
    for(let r=currentRows+1;r<=newRowCount;r++){
      const tr=document.createElement('tr');
      let html='<td class="xls-rowhead">'+r+'</td>';
      for(let c=1;c<=cols;c++){html+='<td><input type="text" id="'+xlsCellId(r,c)+'" data-r="'+r+'" data-c="'+c+'"></td>';}
      html+='<td class="org-row-del-cell"><button type="button" class="btn sm danger xls-row-del">✖</button></td>';
      tr.innerHTML=html;
      tbody.appendChild(tr);
    }
    rowsInput.value=newRowCount;
  }

  // چسباندن هوشمند (مثل اکسل): وقتی چند اسم/کد را که از یک ستون کپی کرده‌اید در یک خانه پیست می‌کنید،
  // به‌صورت خودکار هرکدام در خانه‌ی زیرین خودش قرار می‌گیرد (و در صورت نیاز، ردیف جدید هم اضافه می‌شود)
  document.getElementById('custom-table-body').addEventListener('paste',function(e){
    const target=e.target;
    if(!target || target.tagName!=='INPUT' || !target.dataset.r)return;
    const text=(e.clipboardData||window.clipboardData).getData('text');
    if(!text)return;
    const lines=text.replace(/\\r/g,'').split('\\n');
    while(lines.length>1 && lines[lines.length-1]==='')lines.pop();
    const grid=lines.map(l=>l.split('\\t'));
    const isMulti=grid.length>1||(grid[0]&&grid[0].length>1);
    if(!isMulti)return; // فقط یک مقدار تکی است؛ رفتار پیش‌فرض مرورگر کافی است
    e.preventDefault();
    const startR=parseInt(target.dataset.r),startC=parseInt(target.dataset.c);
    const cols=parseInt(document.getElementById('tbl-cols').value)||4;
    xlsEnsureRows(startR+grid.length-1);
    grid.forEach((rowArr,ri)=>{
      rowArr.forEach((val,ci)=>{
        const rr=startR+ri,cc=startC+ci;
        if(cc>cols)return;
        const cell=document.getElementById(xlsCellId(rr,cc));
        if(cell)cell.value=val.trim();
      });
    });
    if(document.getElementById('tbl-avg-check').checked)calcAndShowAvg();
    toast('چسبانده شد: '+grid.length+' ردیف ✅');
  });

  function xlsGetData(){
    const rows=parseInt(document.getElementById('tbl-rows').value)||5;
    const cols=parseInt(document.getElementById('tbl-cols').value)||4;
    const titles=[];for(let c=1;c<=cols;c++){const el=document.getElementById(xlsTitleId(c));titles.push(el?el.value||('ستون '+c):('ستون '+c));}
    const data=[];
    for(let r=1;r<=rows;r++){
      const row=[];
      for(let c=1;c<=cols;c++){const el=document.getElementById(xlsCellId(r,c));row.push(el?el.value:'');}
      data.push(row);
    }
    return {rows, cols, titles, data};
  }

  document.getElementById('btn-word-table').onclick=function(){
    const title=document.getElementById('tbl-title').value||'جدول';
    const showAvg=document.getElementById('tbl-avg-check').checked;
    const {rows, cols, titles, data}=xlsGetData();
    let style='<style>body{direction:rtl;font-family:tahoma,Arial;padding:20px}table{width:100%;border-collapse:collapse;margin-top:15px}th,td{border:1px solid #333;padding:8px;text-align:center}th{background:#667eea;color:#fff}td:first-child{background:#eee;font-weight:bold}</style>';
    let h='<h2 style="text-align:center">'+title+'</h2><table><tr><th>#</th>';
    for(let c=0;c<cols;c++){h+='<th>'+esc(titles[c])+'</th>';}h+='</tr>';
    for(let r=0;r<rows;r++){
      h+='<tr><td>'+(r+1)+'</td>';
      for(let c=0;c<cols;c++){h+='<td>'+esc(data[r][c])+'</td>';}
      h+='</tr>';
    }
    if(showAvg){
      const avgCells=[];for(let c=0;c<cols;c++){const vals=[];for(let r=0;r<rows;r++){const v=parseFloat(data[r][c]);if(!isNaN(v))vals.push(v);}avgCells.push(vals.length>0?(vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(2):'—');}
      h+='<tr style="background:#e2efda;font-weight:bold"><td>📈 میانگین</td>';
      for(let c=0;c<cols;c++){h+='<td>'+avgCells[c]+'</td>';}h+='</tr>';
    }
    h+='</table>';
    const blob=new Blob(['<html><head><meta charset="utf-8">'+style+'</head><body>'+h+'</body></html>'],{type:'application/msword'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=title+'.doc';document.body.appendChild(a);a.click();a.remove();
  };

  let exceljsLoading=null;
  function loadExcelJS(){
    if(window.ExcelJS) return Promise.resolve();
    if(exceljsLoading) return exceljsLoading;
    exceljsLoading=new Promise(function(resolve,reject){
      const s=document.createElement('script');
      s.src='https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.3.0/exceljs.min.js';
      s.onload=resolve; s.onerror=function(){reject(new Error('load-failed'));};
      document.head.appendChild(s);
    });
    return exceljsLoading;
  }

  document.getElementById('btn-excel-table').onclick=async function(){
    const btn=this;
    const title=document.getElementById('tbl-title').value||'جدول';
    const showAvg=document.getElementById('tbl-avg-check').checked;
    const {rows, cols, titles, data}=xlsGetData();
    btn.disabled=true; const origText=btn.textContent; btn.textContent='⏳ در حال ساخت فایل...';
    try{
      await loadExcelJS();
      const wb=new ExcelJS.Workbook();
      wb.creator=${JSON.stringify(APP_TITLE)};
      const ws=wb.addWorksheet('جدول', { views:[{ rightToLeft:true, state:'frozen', ySplit:2 }] });

      // عنوان بزرگ ادغام‌شده در بالای جدول
      ws.mergeCells(1,1,1,cols+1);
      const titleCell=ws.getCell(1,1);
      titleCell.value=title;
      titleCell.font={ name:'Calibri', size:16, bold:true, color:{argb:'FF1E293B'} };
      titleCell.alignment={ horizontal:'center', vertical:'middle' };
      ws.getRow(1).height=28;

      // سرستون‌ها
      const headerRow=ws.getRow(2);
      headerRow.getCell(1).value='#';
      for(let c=0;c<cols;c++) headerRow.getCell(c+2).value=titles[c];
      headerRow.eachCell(function(cell){
        cell.font={ name:'Calibri', bold:true, color:{argb:'FFFFFFFF'} };
        cell.fill={ type:'pattern', pattern:'solid', fgColor:{argb:'FF4472C4'} };
        cell.alignment={ horizontal:'center', vertical:'middle' };
        cell.border={ top:{style:'thin',color:{argb:'FFB7B7B7'}}, left:{style:'thin',color:{argb:'FFB7B7B7'}}, right:{style:'thin',color:{argb:'FFB7B7B7'}}, bottom:{style:'thin',color:{argb:'FFB7B7B7'}} };
      });
      headerRow.height=22;

      // داده‌ها
      for(let r=0;r<rows;r++){
        const row=ws.getRow(r+3);
        row.getCell(1).value=r+1;
        for(let c=0;c<cols;c++){
          const raw=data[r][c];
          const num=parseFloat(raw);
          row.getCell(c+2).value=(raw!==''&&!isNaN(num)&&String(num)===raw.trim())?num:(raw||'');
        }
        row.eachCell({includeEmpty:true},function(cell,colNum){
          if(colNum>cols+1) return;
          cell.alignment={ horizontal:'center', vertical:'middle' };
          cell.border={ top:{style:'thin',color:{argb:'FFD4D4D4'}}, left:{style:'thin',color:{argb:'FFD4D4D4'}}, right:{style:'thin',color:{argb:'FFD4D4D4'}}, bottom:{style:'thin',color:{argb:'FFD4D4D4'}} };
          if((r+3)%2===0) cell.fill={ type:'pattern', pattern:'solid', fgColor:{argb:'FFFAFBFC'} };
        });
      }

      // ردیف میانگین با فرمول واقعی اکسل =AVERAGE(...)
      if(showAvg){
        const avgRow=ws.getRow(rows+3);
        avgRow.getCell(1).value='📈 میانگین';
        for(let c=0;c<cols;c++){
          const colL=colLetter(c+2); // ستون داده در شیت از ستون B شروع می‌شود
          const range=colL+'3:'+colL+(rows+2);
          avgRow.getCell(c+2).value={ formula:'IFERROR(AVERAGE('+range+'),"—")' };
          avgRow.getCell(c+2).numFmt='0.00';
        }
        avgRow.eachCell(function(cell){
          cell.font={ bold:true, color:{argb:'FF375623'} };
          cell.fill={ type:'pattern', pattern:'solid', fgColor:{argb:'FFE2EFDA'} };
          cell.alignment={ horizontal:'center', vertical:'middle' };
          cell.border={ top:{style:'thin',color:{argb:'FFB7B7B7'}}, left:{style:'thin',color:{argb:'FFB7B7B7'}}, right:{style:'thin',color:{argb:'FFB7B7B7'}}, bottom:{style:'thin',color:{argb:'FFB7B7B7'}} };
        });
      }

      // عرض ستون‌ها
      ws.getColumn(1).width=6;
      for(let c=0;c<cols;c++) ws.getColumn(c+2).width=Math.max(12, (titles[c]||'').length+4);

      const buf=await wb.xlsx.writeBuffer();
      const blob=new Blob([buf], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=title+'.xlsx'; document.body.appendChild(a); a.click(); a.remove();
      toast('فایل Excel ساخته شد ✅');
    }catch(err){
      toast('خطا در ساخت فایل Excel — اتصال اینترنت را بررسی کنید');
    }finally{
      btn.disabled=false; btn.textContent=origText;
    }
  };

  // ===== فرم سازمان عملی (فایل اکسل رسمی دو-شیتی مخصوص مدارس ابتدایی) =====
  const ORG_GRADES=['اول','دوم','سوم','چهارم','پنجم','ششم'];
  const ORG_STAT_ROWS=[...ORG_GRADES,'چندپایه'];

  function orgRenderStatTable(){
    const body=document.getElementById('org-stat-body');
    let html='';
    ORG_STAT_ROWS.forEach((g,idx)=>{
      const gr=idx+1;
      html+='<tr><td style="font-weight:700">'+(g==='چندپایه'?'چندپایه':'پایه '+g)+'</td>'+
        '<td><input type="text" inputmode="numeric" class="org-cls-boy" data-grade="'+gr+'"></td>'+
        '<td><input type="text" inputmode="numeric" class="org-cls-girl" data-grade="'+gr+'"></td>'+
        '<td><input type="text" inputmode="numeric" class="org-cls-mixed" data-grade="'+gr+'"></td>'+
        '<td class="org-cls-sum" data-grade="'+gr+'">۰</td>'+
        '<td><input type="text" inputmode="numeric" class="org-stu-boy" data-grade="'+gr+'"></td>'+
        '<td><input type="text" inputmode="numeric" class="org-stu-girl" data-grade="'+gr+'"></td>'+
        '<td class="org-stu-sum" data-grade="'+gr+'">۰</td></tr>';
    });
    body.innerHTML=html;
    orgRecalcStats();
  }
  function orgRecalcStats(){
    const totals=new Array(6).fill(0);
    ORG_STAT_ROWS.forEach((g,idx)=>{
      const gr=idx+1;
      const val=cls=>parseInt(toEnDigits(document.querySelector('.'+cls+'[data-grade="'+gr+'"]').value),10)||0;
      const clsB=val('org-cls-boy'),clsG=val('org-cls-girl'),clsM=val('org-cls-mixed');
      const stuB=val('org-stu-boy'),stuG=val('org-stu-girl');
      document.querySelector('.org-cls-sum[data-grade="'+gr+'"]').textContent=toFaDigits(clsB+clsG+clsM);
      document.querySelector('.org-stu-sum[data-grade="'+gr+'"]').textContent=toFaDigits(stuB+stuG);
      const vals=[clsB,clsG,clsM,clsB+clsG+clsM,stuB,stuG,stuB+stuG];
      vals.forEach((v,i)=>totals[i]+=v);
    });
    const foot=document.getElementById('org-stat-foot');
    foot.innerHTML='<tr style="font-weight:800;background:#eef2ff"><td>جمع</td>'+
      totals.map(t=>'<td>'+toFaDigits(t)+'</td>').join('')+'</tr>';
  }
  document.getElementById('org-stat-body').addEventListener('input',function(e){
    if(e.target && e.target.tagName==='INPUT'){
      const cleaned=toEnDigits(e.target.value).replace(/[^0-9]/g,'').slice(0,4);
      e.target.value=toFaDigits(cleaned);
      orgRecalcStats();
    }
  });

  // ===== تعداد دانش‌آموزان خاص =====
  const ORG_SPECIAL_LABELS=['فرزندان شاهد','تلفیقی شدید','تلفیقی خفیف','تحت پوشش','اتباع خارجی','جذب بازمانده'];
  function orgRenderSpecialTable(){
    const body=document.getElementById('org-special-body');
    body.innerHTML=ORG_SPECIAL_LABELS.map((lab,idx)=>
      '<tr><td style="font-weight:700;text-align:right">'+lab+':</td><td><input type="text" inputmode="numeric" class="org-special-val" data-idx="'+idx+'"></td></tr>'
    ).join('');
  }
  document.getElementById('org-special-body').addEventListener('input',function(e){
    if(e.target && e.target.tagName==='INPUT'){
      const cleaned=toEnDigits(e.target.value).replace(/[^0-9]/g,'').slice(0,4);
      e.target.value=toFaDigits(cleaned);
    }
  });

  function orgRenumberRows(tbodyId){
    document.querySelectorAll('#'+tbodyId+' > tr').forEach((tr,idx)=>{
      const firstCell=tr.children[0];
      if(firstCell)firstCell.textContent=idx+1;
    });
  }
  function orgAddStaffRow(){
    const tbody=document.getElementById('org-staff-body');
    const rowNum=tbody.children.length+1;
    const tr=document.createElement('tr');
    tr.innerHTML='<td>'+rowNum+'</td>'+
      '<td><input type="text"></td><td><input type="text"></td><td><input type="text"></td><td><input type="text"></td>'+
      '<td><input type="text"></td>'+
      '<td><input type="text"></td><td><input type="text"></td><td><input type="text"></td><td><input type="text"></td><td><input type="text"></td><td><input type="text"></td>'+
      '<td class="org-row-del-cell"><button type="button" class="btn sm danger org-row-del">✖</button></td>';
    tbody.appendChild(tr);
  }
  document.getElementById('btn-org-staff-addrow').onclick=orgAddStaffRow;
  document.getElementById('org-staff-body').addEventListener('click',function(e){
    const btn=e.target.closest('.org-row-del');
    if(!btn)return;
    const tr=btn.closest('tr');
    if(tr)tr.remove();
    orgRenumberRows('org-staff-body');
  });
  document.getElementById('org-staff-table').addEventListener('paste',function(e){
    const target=e.target;
    if(!target||(target.tagName!=='INPUT'&&target.tagName!=='SELECT'))return;
    const td=target.closest('td');const tr=td.closest('tr');const tbody=tr.parentElement;
    const tds=Array.from(tr.children);
    const colIdx=tds.indexOf(td);
    let rows=Array.from(tbody.children);
    const rowIdx=rows.indexOf(tr);
    const text=(e.clipboardData||window.clipboardData).getData('text');
    if(!text)return;
    const lines=text.replace(/\\r/g,'').split('\\n');
    while(lines.length>1&&lines[lines.length-1]==='')lines.pop();
    const grid=lines.map(l=>l.split('\t'));
    const isMulti=grid.length>1||(grid[0]&&grid[0].length>1);
    if(!isMulti)return;
    e.preventDefault();
    while(rows.length<rowIdx+grid.length){orgAddStaffRow();rows=Array.from(tbody.children);}
    grid.forEach((rowArr,ri)=>{
      const targetTr=rows[rowIdx+ri];
      if(!targetTr)return;
      const targetTds=Array.from(targetTr.children);
      rowArr.forEach((val,ci)=>{
        const cc=colIdx+ci;
        if(cc>=targetTds.length||cc===0)return;
        const el=targetTds[cc].querySelector('input,select');
        if(el)el.value=val.trim();
      });
    });
    toast('چسبانده شد: '+grid.length+' ردیف ✅');
  });

  function orgAddHoursRow(){
    const tbody=document.getElementById('org-hours-body');
    const rowNum=tbody.children.length+1;
    const tr=document.createElement('tr');
    let html='<td>'+rowNum+'</td><td><input type="text" class="org-hr-code"></td><td><input type="text" class="org-hr-name"></td>';
    for(let g=1;g<=7;g++){
      html+='<td><input type="text" inputmode="numeric" class="org-hr-mo" data-g="'+g+'"></td>'+
            '<td><input type="text" inputmode="numeric" class="org-hr-gh" data-g="'+g+'"></td>'+
            '<td class="org-hr-rowsum" data-g="'+g+'">۰</td>';
    }
    html+='<td class="org-hr-total-mo">۰</td><td class="org-hr-total-gh">۰</td><td class="org-hr-total-sum">۰</td>';
    html+='<td class="org-row-del-cell"><button type="button" class="btn sm danger org-row-del">✖</button></td>';
    tr.innerHTML=html;
    tbody.appendChild(tr);
  }
  document.getElementById('btn-org-hours-addrow').onclick=orgAddHoursRow;
  document.getElementById('org-hours-body').addEventListener('click',function(e){
    const btn=e.target.closest('.org-row-del');
    if(!btn)return;
    const tr=btn.closest('tr');
    if(tr)tr.remove();
    orgRenumberRows('org-hours-body');
  });
  function orgRecalcHoursRow(tr){
    let totalMo=0,totalGh=0;
    for(let g=1;g<=7;g++){
      const mo=parseInt(toEnDigits(tr.querySelector('.org-hr-mo[data-g="'+g+'"]').value),10)||0;
      const gh=parseInt(toEnDigits(tr.querySelector('.org-hr-gh[data-g="'+g+'"]').value),10)||0;
      tr.querySelector('.org-hr-rowsum[data-g="'+g+'"]').textContent=toFaDigits(mo+gh);
      totalMo+=mo;totalGh+=gh;
    }
    tr.querySelector('.org-hr-total-mo').textContent=toFaDigits(totalMo);
    tr.querySelector('.org-hr-total-gh').textContent=toFaDigits(totalGh);
    tr.querySelector('.org-hr-total-sum').textContent=toFaDigits(totalMo+totalGh);
  }
  document.getElementById('org-hours-body').addEventListener('input',function(e){
    if(!e.target||e.target.tagName!=='INPUT')return;
    if(e.target.classList.contains('org-hr-mo')||e.target.classList.contains('org-hr-gh')){
      const cleaned=toEnDigits(e.target.value).replace(/[^0-9]/g,'').slice(0,3);
      e.target.value=toFaDigits(cleaned);
    }
    const tr=e.target.closest('tr');
    if(!tr)return;
    orgRecalcHoursRow(tr);
  });

  // چسباندن هوشمند برای جدول ساعات (کد پرسنلی / نام)
  document.getElementById('org-hours-table').addEventListener('paste',function(e){
    const target=e.target;
    if(!target||target.tagName!=='INPUT')return;
    const td=target.closest('td');const tr=td.closest('tr');const tbody=tr.parentElement;
    const tds=Array.from(tr.children);
    const colIdx=tds.indexOf(td);
    let rows=Array.from(tbody.children);
    const rowIdx=rows.indexOf(tr);
    const text=(e.clipboardData||window.clipboardData).getData('text');
    if(!text)return;
    const lines=text.replace(/\\r/g,'').split('\\n');
    while(lines.length>1&&lines[lines.length-1]==='')lines.pop();
    if(lines.length<2)return;
    e.preventDefault();
    while(rows.length<rowIdx+lines.length){orgAddHoursRow();rows=Array.from(tbody.children);}
    lines.forEach((val,ri)=>{
      const targetTr=rows[rowIdx+ri];
      if(!targetTr)return;
      const targetTds=Array.from(targetTr.children);
      if(targetTds[colIdx]){
        const inp=targetTds[colIdx].querySelector('input');
        if(inp)inp.value=val.trim();
      }
    });
    toast('چسبانده شد: '+lines.length+' ردیف ✅');
  });

  let ORG_FORM_LOADED=false;
  async function loadOrgFormIfNeeded(){
    orgRenderStatTable();
    orgRenderSpecialTable();
    if(document.getElementById('org-staff-body').children.length===0){for(let i=0;i<3;i++)orgAddStaffRow();}
    if(document.getElementById('org-hours-body').children.length===0){for(let i=0;i<3;i++)orgAddHoursRow();}
    if(ORG_FORM_LOADED)return;
    ORG_FORM_LOADED=true;
    const saved=await lbLoad('orgform');
    if(!saved)return;
    ['year','formno','region','school','schoolcode','principal','gender','level','spacecode','adminType','buildingStatus','status','buildingType','phone','address'].forEach(k=>{
      const el=document.getElementById('org-'+k);
      if(el && saved[k]!==undefined)el.value=saved[k];
    });
    if(saved.stats){
      saved.stats.forEach((row,idx)=>{
        const gr=idx+1;
        ['stu-boy','stu-girl','cls-boy','cls-girl','cls-mixed'].forEach(k=>{
          const el=document.querySelector('.org-'+k+'[data-grade="'+gr+'"]');
          if(el && row[k]!==undefined)el.value=toFaDigits(row[k]);
        });
      });
      orgRecalcStats();
    }
    if(saved.special){
      saved.special.forEach((v,idx)=>{
        const el=document.querySelector('.org-special-val[data-idx="'+idx+'"]');
        if(el && v!==undefined)el.value=toFaDigits(v);
      });
    }
    if(saved.staff && saved.staff.length){
      document.getElementById('org-staff-body').innerHTML='';
      saved.staff.forEach(()=>orgAddStaffRow());
      const rows=document.querySelectorAll('#org-staff-body tr');
      saved.staff.forEach((rowVals,ri)=>{
        const tds=Array.from(rows[ri].children);
        rowVals.forEach((v,ci)=>{
          const cellIdx=ci+1;
          if(!tds[cellIdx])return;
          const el=tds[cellIdx].querySelector('input,select');
          if(el)el.value=v;
        });
      });
    }
    if(saved.hours && saved.hours.length){
      document.getElementById('org-hours-body').innerHTML='';
      saved.hours.forEach(()=>orgAddHoursRow());
      const rows=document.querySelectorAll('#org-hours-body tr');
      saved.hours.forEach((rowVals,ri)=>{
        const tr=rows[ri];
        tr.querySelector('.org-hr-code').value=rowVals.code||'';
        tr.querySelector('.org-hr-name').value=rowVals.name||'';
        (rowVals.g||[]).forEach((pair,gi)=>{
          const g=gi+1;
          const moEl=tr.querySelector('.org-hr-mo[data-g="'+g+'"]');
          const ghEl=tr.querySelector('.org-hr-gh[data-g="'+g+'"]');
          if(moEl)moEl.value=toFaDigits(pair.mo||'');
          if(ghEl)ghEl.value=toFaDigits(pair.gh||'');
        });
        orgRecalcHoursRow(tr);
      });
    }
  }

  function orgGatherData(){
    const meta={};
    ['year','formno','region','school','schoolcode','principal','gender','level','spacecode','adminType','buildingStatus','status','buildingType','phone','address'].forEach(k=>{
      meta[k]=(document.getElementById('org-'+k)||{}).value||'';
    });
    const stats=ORG_STAT_ROWS.map((g,idx)=>{
      const gr=idx+1;
      const v=cls=>toEnDigits(document.querySelector('.org-'+cls+'[data-grade="'+gr+'"]').value||'');
      return{'stu-boy':v('stu-boy'),'stu-girl':v('stu-girl'),'cls-boy':v('cls-boy'),'cls-girl':v('cls-girl'),'cls-mixed':v('cls-mixed')};
    });
    const special=[];
    document.querySelectorAll('.org-special-val').forEach(el=>{special.push(toEnDigits(el.value||''));});
    const staff=[];
    document.querySelectorAll('#org-staff-body tr').forEach(tr=>{
      const cells=Array.from(tr.children).slice(1).filter(td=>!td.classList.contains('org-row-del-cell')).map(td=>{
        const el=td.querySelector('input,select');
        return el?el.value:'';
      });
      staff.push(cells);
    });
    const hours=[];
    document.querySelectorAll('#org-hours-body tr').forEach(tr=>{
      const code=tr.querySelector('.org-hr-code').value;
      const name=tr.querySelector('.org-hr-name').value;
      const g=[];
      for(let gi=1;gi<=7;gi++){
        g.push({mo:toEnDigits(tr.querySelector('.org-hr-mo[data-g="'+gi+'"]').value||''),gh:toEnDigits(tr.querySelector('.org-hr-gh[data-g="'+gi+'"]').value||'')});
      }
      hours.push({code,name,g});
    });
    return{...meta,stats,special,staff,hours};
  }

  document.getElementById('btn-org-save').onclick=async function(){
    await lbSave('orgform',orgGatherData());
  };
  document.getElementById('btn-org-print').onclick=function(){window.print();};

  // ===== ساخت آزمون (برگه چاپی) =====
  let esRows=[{q:'',mark:''}];
  let esFontSize=12;

  // ساخت یک جدول قابل‌مدیریت (با نوار ابزار: افزودن/حذف ردیف و ستون، جابه‌جایی، تغییر اندازه، حذف کامل جدول)
  function esBuildTableWrapHtml(r,c){
    let rowsHtml='';
    for(let rr=0;rr<r;rr++){
      rowsHtml+='<tr>';
      for(let cc=0;cc<c;cc++){rowsHtml+='<td>&nbsp;</td>';}
      rowsHtml+='</tr>';
    }
    return '<div class="es-tbl-wrap" contenteditable="false" style="width:70%">'+
      '<div class="es-tbl-toolbar" contenteditable="false">'+
        '<button type="button" data-tact="addrow" title="افزودن ردیف">➕ردیف</button>'+
        '<button type="button" data-tact="delrow" title="حذف آخرین ردیف">➖ردیف</button>'+
        '<button type="button" data-tact="addcol" title="افزودن ستون">➕ستون</button>'+
        '<button type="button" data-tact="delcol" title="حذف آخرین ستون">➖ستون</button>'+
        '<button type="button" data-tact="wbig" title="بزرگ‌تر کردن جدول">↔️ بزرگ‌تر</button>'+
        '<button type="button" data-tact="wsmall" title="کوچک‌تر کردن جدول">↔️ کوچک‌تر</button>'+
        '<button type="button" data-tact="up" title="جابه‌جایی به بالا">⬆️</button>'+
        '<button type="button" data-tact="down" title="جابه‌جایی به پایین">⬇️</button>'+
        '<button type="button" class="es-tbl-del" data-tact="del" title="حذف کامل این جدول">🗑️ حذف جدول</button>'+
      '</div>'+
      '<table contenteditable="true"><tbody>'+rowsHtml+'</tbody></table>'+
    '</div><div><br></div>';
  }

  const ES_SPACE_DEFAULT=90, ES_SPACE_MIN=40, ES_SPACE_MAX=500, ES_SPACE_STEP=20;

  function esRenderRows(){
    const tbody=document.getElementById('es-rows');
    tbody.innerHTML=esRows.map(function(r,i){
      const sp=r.space||ES_SPACE_DEFAULT;
      return '<tr>'+
        '<td class="es-col-num">'+toFaDigits(i+1)+(esRows.length>1?'<div><button type="button" class="es-row-del" data-i="'+i+'" title="حذف این سؤال">✕ حذف</button></div>':'')+'</td>'+
        '<td class="es-q-cell">'+
          '<div class="es-q" data-i="'+i+'" contenteditable="true" style="min-height:'+sp+'px">'+(r.q||'')+'</div>'+
          '<div class="es-q-tools">'+
            '<button type="button" class="es-q-addtable" data-i="'+i+'">🔲 افزودن جدول</button>'+
            '<span class="es-space-ctrl">📏 فضای پاسخ:'+
              '<button type="button" class="es-space-btn" data-i="'+i+'" data-dir="-1" title="فضای کمتر برای این سؤال">➖</button>'+
              '<b class="es-space-val" data-i="'+i+'">'+toFaDigits(sp)+'</b>'+
              '<button type="button" class="es-space-btn" data-i="'+i+'" data-dir="1" title="فضای بیشتر برای این سؤال">➕</button>'+
            '</span>'+
          '</div>'+
        '</td>'+
        '<td class="es-col-mark"><input class="es-mark" data-i="'+i+'" value="'+esc(r.mark||'')+'"></td>'+
        '</tr>';
    }).join('');
    tbody.querySelectorAll('.es-q').forEach(function(el){convertDigitsInElement(el);el.oninput=function(){convertDigitsInElement(this);esRows[+this.dataset.i].q=this.innerHTML;};});
    tbody.querySelectorAll('.es-mark').forEach(function(el){el.oninput=function(){esRows[+this.dataset.i].mark=this.value;};});
    tbody.querySelectorAll('.es-row-del').forEach(function(el){el.onclick=function(){esRows.splice(+this.dataset.i,1);esRenderRows();};});
    tbody.querySelectorAll('.es-space-btn').forEach(function(el){
      el.onclick=function(){
        const i=+this.dataset.i;
        const dir=+this.dataset.dir;
        let cur=esRows[i].space||ES_SPACE_DEFAULT;
        cur=Math.max(ES_SPACE_MIN,Math.min(ES_SPACE_MAX,cur+dir*ES_SPACE_STEP));
        esRows[i].space=cur;
        const qEl=tbody.querySelector('.es-q[data-i="'+i+'"]');
        qEl.style.minHeight=cur+'px';
        const valEl=tbody.querySelector('.es-space-val[data-i="'+i+'"]');
        valEl.textContent=toFaDigits(cur);
      };
    });
    tbody.querySelectorAll('.es-q-addtable').forEach(function(el){
      el.onclick=function(){
        const i=+this.dataset.i;
        const qEl=tbody.querySelector('.es-q[data-i="'+i+'"]');
        let r=parseInt(toEnDigits(prompt('تعداد ردیف جدول؟','2')),10);
        let c=parseInt(toEnDigits(prompt('تعداد ستون جدول؟','2')),10);
        if(!r||r<1)r=2;if(!c||c<1)c=2;
        // جدول همیشه به انتهای متن سؤال اضافه می‌شود تا سؤال بالای جدول باقی بماند
        qEl.insertAdjacentHTML('beforeend',esBuildTableWrapHtml(r,c));
        esRows[i].q=qEl.innerHTML;
      };
    });
  }

  // مدیریت کلیک روی دکمه‌های نوار ابزار هر جدول (افزودن/حذف ردیف و ستون، جابه‌جایی، بزرگ/کوچک کردن، حذف جدول)
  document.getElementById('es-rows').addEventListener('click',function(e){
    const btn=e.target.closest('[data-tact]');
    if(!btn)return;
    e.preventDefault();
    const wrap=btn.closest('.es-tbl-wrap');
    const qEl=btn.closest('.es-q-cell').querySelector('.es-q');
    const i=+qEl.dataset.i;
    const table=wrap.querySelector('table');
    const act=btn.dataset.tact;
    if(act==='addrow'){
      const cols=table.rows.length?table.rows[0].cells.length:1;
      const tr=table.insertRow(-1);
      for(let c=0;c<cols;c++){const td=tr.insertCell(-1);td.innerHTML='&nbsp;';}
    }else if(act==='delrow'){
      if(table.rows.length>1)table.deleteRow(-1);else toast('حداقل یک ردیف باید در جدول باقی بماند');
    }else if(act==='addcol'){
      Array.from(table.rows).forEach(function(row){const td=row.insertCell(-1);td.innerHTML='&nbsp;';});
    }else if(act==='delcol'){
      const ncols=table.rows.length?table.rows[0].cells.length:0;
      if(ncols>1){Array.from(table.rows).forEach(function(row){row.deleteCell(-1);});}else toast('حداقل یک ستون باید در جدول باقی بماند');
    }else if(act==='wbig'){
      let w=parseInt(wrap.style.width,10)||70;w=Math.min(100,w+10);wrap.style.width=w+'%';
    }else if(act==='wsmall'){
      let w=parseInt(wrap.style.width,10)||70;w=Math.max(20,w-10);wrap.style.width=w+'%';
    }else if(act==='up'){
      let prev=wrap.previousElementSibling;
      while(prev&&prev.tagName==='BR')prev=prev.previousElementSibling;
      if(prev)wrap.parentNode.insertBefore(wrap,prev);
    }else if(act==='down'){
      let next=wrap.nextElementSibling;
      if(next){const after=next.nextElementSibling;if(after)wrap.parentNode.insertBefore(after,wrap);}
    }else if(act==='del'){
      if(confirm('آیا از حذف کامل این جدول مطمئن هستید؟ این کار قابل بازگشت نیست.'))wrap.remove();else return;
    }
    convertDigitsInElement(table);
    esRows[i].q=qEl.innerHTML;
  });

  esRenderRows();
  document.getElementById('btn-es-addrow').onclick=function(){esRows.push({q:'',mark:''});esRenderRows();};

  function esApplyFontSize(v){
    esFontSize=parseInt(v,10)||12;
    document.getElementById('es-print-area').style.setProperty('--es-font-size',esFontSize+'pt');
  }
  document.getElementById('es-font-size').addEventListener('input',function(){esApplyFontSize(this.value);});
  esApplyFontSize(12);

  function esGatherData(){
    return {
      org1:document.getElementById('es-org1').value,
      org2:document.getElementById('es-org2').value,
      examtitle:document.getElementById('es-examtitle').value,
      examtitleExtra:document.getElementById('es-examtitle-extra').value,
      date:document.getElementById('es-date').value,
      time:document.getElementById('es-time').value,
      course:document.getElementById('es-course').value,
      teacherLabel:document.getElementById('es-teacher-label').value,
      teacher:document.getElementById('es-teacher').value,
      markLabel:document.getElementById('es-mark-label').value,
      grade:document.getElementById('es-grade').value,
      schoolyear:document.getElementById('es-schoolyear').value,
      fontSize:esFontSize,
      rows:esRows
    };
  }
  document.getElementById('btn-es-save').onclick=function(){lbSave('examsheet',esGatherData());};
  document.getElementById('btn-es-word').onclick=async function(){
    await lbSave('examsheet',esGatherData(),true);
    window.open('/api/teacher/word?type=examsheet','_blank');
  };
  document.getElementById('btn-es-pdf').onclick=function(){
    const html=getExamSheetHtmlForExport();
    const w=window.open('','_blank');
    w.document.write(html);w.document.close();
    setTimeout(function(){w.print();},500);
  };

  function getExamSheetHtmlForExport(){
    const d=esGatherData();
    const fs=parseInt(d.fontSize,10)||12;
    let style='<style>body{direction:rtl;font-family:"B Nazanin",Tahoma,Arial;font-weight:bold;padding:10px;font-size:'+fs+'pt}';
    style+='table{width:100%;border-collapse:collapse;table-layout:fixed;margin-bottom:6px}';
    style+='td,th{border:1px solid #000;padding:6px 8px;font-size:'+fs+'pt;vertical-align:top}';
    style+='th{background:#f1f5f9;text-align:center;font-weight:bold}';
    style+='.qnum{width:44px;text-align:center;font-weight:bold}.mk{width:64px;text-align:center}';
    style+='thead{display:table-header-group}tr{page-break-inside:avoid}';
    style+='.es-tbl-toolbar{display:none!important}.es-tbl-wrap{border:none!important;padding:0!important}</style>';
    let h='<table><tr>'+
      '<td>نام و نام‌خانوادگی: ...................................</td>'+
      '<td style="text-align:center">'+esc(d.org1)+'</td>'+
      '<td>تاریخ آزمون: '+esc(d.date)+'</td>'+
      '</tr><tr>'+
      '<td>نام پدر: ...................................</td>'+
      '<td style="text-align:center">'+esc(d.org2)+'</td>'+
      '<td>زمان آزمون: '+esc(d.time)+'</td>'+
      '</tr><tr>'+
      '<td>رشته / پایه: '+esc(d.grade)+'</td>'+
      '<td>سال تحصیلی: '+esc(d.schoolyear)+'</td>'+
      '<td>'+esc(d.examtitle)+(d.examtitleExtra?' - '+esc(d.examtitleExtra):'')+'</td>'+
      '</tr></table>'+
      '<table><tr><td>نام درس: '+esc(d.course)+'</td><td>'+esc(d.teacherLabel)+': '+esc(d.teacher)+'</td></tr></table>';
    let q='<table><thead><tr><th class="qnum">ردیف</th><th>سؤال</th><th class="mk">'+esc(d.markLabel)+'</th></tr></thead><tbody>';
    d.rows.forEach(function(r,i){
      const sp=r.space||90;
      q+='<tr><td class="qnum">'+toFaDigits(i+1)+'</td><td style="min-height:'+sp+'px">'+(r.q||'')+'</td><td style="text-align:center">'+esc(r.mark||'')+'</td></tr>';
    });
    q+='</tbody></table>';
    return '<html><head><meta charset="utf-8">'+style+'</head><body>'+h+q+'</body></html>';
  }

  let esLoaded=false;
  async function loadExamSheetIfNeeded(){
    if(esLoaded)return;esLoaded=true;
    const d=await lbLoad('examsheet');
    if(!d)return;
    if(d.org1!=null)document.getElementById('es-org1').value=d.org1;
    if(d.org2!=null)document.getElementById('es-org2').value=d.org2;
    if(d.examtitle!=null)document.getElementById('es-examtitle').value=d.examtitle;
    if(d.examtitleExtra!=null)document.getElementById('es-examtitle-extra').value=d.examtitleExtra;
    if(d.date!=null)document.getElementById('es-date').value=d.date;
    if(d.time!=null)document.getElementById('es-time').value=d.time;
    if(d.course!=null)document.getElementById('es-course').value=d.course;
    if(d.teacherLabel!=null)document.getElementById('es-teacher-label').value=d.teacherLabel;
    if(d.teacher!=null)document.getElementById('es-teacher').value=d.teacher;
    if(d.markLabel!=null)document.getElementById('es-mark-label').value=d.markLabel;
    if(d.grade!=null)document.getElementById('es-grade').value=d.grade;
    if(d.schoolyear!=null)document.getElementById('es-schoolyear').value=d.schoolyear;
    if(d.fontSize!=null){document.getElementById('es-font-size').value=d.fontSize;esApplyFontSize(d.fontSize);}
    if(Array.isArray(d.rows)&&d.rows.length)esRows=d.rows;
    esRenderRows();
  }


  document.getElementById('btn-org-form').onclick=async function(){
    const btn=this;btn.disabled=true;const origText=btn.textContent;btn.textContent='⏳ در حال ساخت فایل...';
    try{
      await loadExcelJS();
      const orgData=orgGatherData();
      const wb=new ExcelJS.Workbook();
      wb.creator='پنل مدیریت کلاسی';

      function numOrBlank(raw){
        if(raw===undefined||raw===null||raw==='')return undefined;
        const n=Number(raw);
        return isNaN(n)?undefined:n;
      }
      // ردیف مهر و امضا در پایین هر شیت: مدیر مدرسه سمت راست، مسئول آموزش سمت چپ
      function addSignatureFooter(ws,startCol,endCol,lastUsedRow){
        const gap=lastUsedRow+2;
        const total=endCol-startCol+1;
        const half=Math.floor(total/2);
        const rightEnd=startCol+half-1;
        const leftStart=rightEnd+1;
        const labelRow=gap;
        ws.mergeCells(labelRow,startCol,labelRow,rightEnd);
        ws.getCell(labelRow,startCol).value='مهر و امضا مدیر مدرسه';
        ws.getCell(labelRow,startCol).font={bold:true,size:11};
        ws.getCell(labelRow,startCol).alignment={horizontal:'center',vertical:'middle'};
        ws.mergeCells(labelRow,leftStart,labelRow,endCol);
        ws.getCell(labelRow,leftStart).value='مهر و امضا مسئول آموزش';
        ws.getCell(labelRow,leftStart).font={bold:true,size:11};
        ws.getCell(labelRow,leftStart).alignment={horizontal:'center',vertical:'middle'};
        ws.getRow(labelRow).height=18;
        const boxRow=labelRow+1;
        ws.mergeCells(boxRow,startCol,boxRow,rightEnd);
        ws.getCell(boxRow,startCol).border={top:{style:'thin',color:{argb:'FF94A3B8'}},left:{style:'thin',color:{argb:'FF94A3B8'}},right:{style:'thin',color:{argb:'FF94A3B8'}},bottom:{style:'thin',color:{argb:'FF94A3B8'}}};
        ws.mergeCells(boxRow,leftStart,boxRow,endCol);
        ws.getCell(boxRow,leftStart).border={top:{style:'thin',color:{argb:'FF94A3B8'}},left:{style:'thin',color:{argb:'FF94A3B8'}},right:{style:'thin',color:{argb:'FF94A3B8'}},bottom:{style:'thin',color:{argb:'FF94A3B8'}}};
        ws.getRow(boxRow).height=55;
        return boxRow;
      }
      const thin={style:'thin',color:{argb:'FFB7B7B7'}};
      const borderAll={top:thin,left:thin,right:thin,bottom:thin};
      const headerFill={type:'pattern',pattern:'solid',fgColor:{argb:'FFD9E2F3'}};
      const inputFill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF6DC'}};
      const groupFill={type:'pattern',pattern:'solid',fgColor:{argb:'FF4472C4'}};

      // ---------- شیت ۱: مشخصات آموزشگاه و آمار دانش‌آموزان ----------
      const ws1=wb.addWorksheet('مشخصات و آمار',{views:[{rightToLeft:true}],pageSetup:{paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:1,margins:{left:0.3,right:0.3,top:0.4,bottom:0.4,header:0.2,footer:0.2},horizontalCentered:true}});
      ws1.mergeCells('A1:N1');
      ws1.getCell('A1').value='فرم سازمان عملی — سازمان ملی تعلیم و تربیت کودک / دوره ابتدایی';
      ws1.getCell('A1').font={size:15,bold:true,color:{argb:'FF1E293B'}};
      ws1.getCell('A1').alignment={horizontal:'center',vertical:'middle'};
      ws1.getRow(1).height=26;

      ws1.mergeCells('A2:N2');
      ws1.getCell('A2').value='مشخصات آموزشگاه';
      ws1.getCell('A2').font={size:12,bold:true,color:{argb:'FFFFFFFF'}};
      ws1.getCell('A2').fill=groupFill;
      ws1.getCell('A2').alignment={horizontal:'center',vertical:'middle'};
      ws1.getRow(2).height=20;

      // فیلدهای مشخصات آموزشگاه: [برچسب, نوع, کلید‌داده, لیست‌دراپ‌داون]
      const infoFields=[
        ['سال تحصیلی','text','year'],['فرم شماره','text','formno'],
        ['منطقه','text','region'],['نام آموزشگاه','text','school'],
        ['کد آموزشگاه','text','schoolcode'],['نام مدیر','text','principal'],
        ['جنسیت','list','gender',['پسر','دختر','مختلط']],['مقطع','text','level'],
        ['کد فضا','text','spacecode'],['نوع اداره','list','adminType',['دولتی','غیردولتی']],
        ['وضعیت ساختمان','list','buildingStatus',['ملکی','استیجاری','سایر']],['وضعیت','list','status',['فعال','غیرفعال']],
        ['نوع ساختمان','list','buildingType',['آجری','بتنی','سایر']],['شماره تلفن','text','phone']
      ];
      let r=3;
      for(let i=0;i<infoFields.length;i+=2){
        const row=ws1.getRow(r);
        row.getCell(1).value=infoFields[i][0]+':';
        row.getCell(1).font={bold:true};
        row.getCell(1).alignment={horizontal:'right',vertical:'middle'};
        ws1.mergeCells(r,2,r,4);
        row.getCell(2).value=orgData[infoFields[i][2]]||'';
        row.getCell(2).fill=inputFill;
        row.getCell(2).border=borderAll;
        row.getCell(2).alignment={horizontal:'right',vertical:'middle'};
        if(infoFields[i][1]==='list'){row.getCell(2).dataValidation={type:'list',allowBlank:true,formulae:['"'+infoFields[i][3].join(',')+'"']};}
        if(infoFields[i+1]){
          row.getCell(8).value=infoFields[i+1][0]+':';
          row.getCell(8).font={bold:true};
          row.getCell(8).alignment={horizontal:'right',vertical:'middle'};
          ws1.mergeCells(r,9,r,11);
          row.getCell(9).value=orgData[infoFields[i+1][2]]||'';
          row.getCell(9).fill=inputFill;
          row.getCell(9).border=borderAll;
          row.getCell(9).alignment={horizontal:'right',vertical:'middle'};
          if(infoFields[i+1][1]==='list'){row.getCell(9).dataValidation={type:'list',allowBlank:true,formulae:['"'+infoFields[i+1][3].join(',')+'"']};}
        }
        row.getCell(1).border=borderAll;row.getCell(8).border=borderAll;
        row.height=20;
        r++;
      }
      // ردیف «سازمان / دوره تحصیلی» ثابت
      ws1.getCell('A'+r).value='سازمان / دوره تحصیلی:';
      ws1.getCell('A'+r).font={bold:true};
      ws1.mergeCells(r,2,r,11);
      ws1.getCell('B'+r).value='سازمان ملی تعلیم و تربیت کودک / دوره ابتدایی';
      ws1.getCell('B'+r).font={italic:true,color:{argb:'FF475569'}};
      ws1.getCell('B'+r).alignment={horizontal:'right',vertical:'middle'};
      r++;
      // نشانی
      ws1.getCell('A'+r).value='نشانی آموزشگاه:';
      ws1.getCell('A'+r).font={bold:true};
      ws1.mergeCells(r,2,r,11);
      ws1.getCell('B'+r).value=orgData.address||'';
      ws1.getCell('B'+r).fill=inputFill;
      ws1.getCell('B'+r).border=borderAll;
      ws1.getCell('B'+r).alignment={horizontal:'right',vertical:'middle'};
      ws1.getRow(r).height=22;
      r+=2;

      // ---------- جدول آمار کلاس‌ها و دانش‌آموزان ----------
      const statTop=r;
      ws1.mergeCells(statTop,1,statTop,8);
      ws1.getCell(statTop,1).value='آمار کلاس‌ها و دانش‌آموزان به تفکیک پایه';
      ws1.getCell(statTop,1).font={size:12,bold:true,color:{argb:'FFFFFFFF'}};
      ws1.getCell(statTop,1).fill=groupFill;
      ws1.getCell(statTop,1).alignment={horizontal:'center',vertical:'middle'};
      ws1.getRow(statTop).height=20;

      const h1=statTop+1,h2=statTop+2;
      ws1.mergeCells(h1,1,h2,1); ws1.getCell(h1,1).value='پایه';
      ws1.mergeCells(h1,2,h1,5); ws1.getCell(h1,2).value='کلاس';
      ws1.mergeCells(h1,6,h1,8); ws1.getCell(h1,6).value='دانش‌آموزان';
      const sub1=['پسرانه','دخترانه','مختلط','جمع'], sub2=['پسر','دختر','جمع'];
      sub1.forEach((t,i)=>{ws1.getCell(h2,2+i).value=t;});
      sub2.forEach((t,i)=>{ws1.getCell(h2,6+i).value=t;});
      for(let rr=h1;rr<=h2;rr++){
        ws1.getRow(rr).eachCell({includeEmpty:true},function(cell,colNum){
          if(colNum>8)return;
          cell.font={bold:true,color:{argb:'FF1E3A8A'}};
          cell.fill=headerFill;
          cell.alignment={horizontal:'center',vertical:'middle',wrapText:true};
          cell.border=borderAll;
        });
        ws1.getRow(rr).height=20;
      }

      const statRows=[...ORG_GRADES,'چندپایه'];
      const dataStart=h2+1;
      statRows.forEach((g,idx)=>{
        const rr=dataStart+idx;
        const st=orgData.stats[idx]||{};
        ws1.getCell(rr,1).value=g==='چندپایه'?g:'پایه '+g;
        ws1.getCell(rr,2).value=numOrBlank(st['cls-boy']);
        ws1.getCell(rr,3).value=numOrBlank(st['cls-girl']);
        ws1.getCell(rr,4).value=numOrBlank(st['cls-mixed']);
        ws1.getCell(rr,5).value={formula:'SUM(B'+rr+':D'+rr+')'};
        ws1.getCell(rr,6).value=numOrBlank(st['stu-boy']);
        ws1.getCell(rr,7).value=numOrBlank(st['stu-girl']);
        ws1.getCell(rr,8).value={formula:'SUM(F'+rr+':G'+rr+')'};
        ws1.getRow(rr).eachCell({includeEmpty:true},function(cell,colNum){
          if(colNum>8)return;
          cell.border=borderAll;
          cell.alignment={horizontal:'center',vertical:'middle'};
          if([2,3,4,6,7].includes(colNum))cell.fill=inputFill;
        });
        ws1.getRow(rr).height=19;
      });
      const totalRow=dataStart+statRows.length;
      ws1.getCell(totalRow,1).value='جمع';
      ws1.getCell(totalRow,1).font={bold:true};
      [2,3,4,5,6,7,8].forEach(function(c){
        const colL=colLetter(c);
        ws1.getCell(totalRow,c).value={formula:'SUM('+colL+dataStart+':'+colL+(totalRow-1)+')'};
      });
      ws1.getRow(totalRow).eachCell({includeEmpty:true},function(cell,colNum){
        if(colNum>8)return;
        cell.font={bold:true,color:{argb:'FF375623'}};
        cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFE2EFDA'}};
        cell.border=borderAll;
        cell.alignment={horizontal:'center',vertical:'middle'};
      });
      ws1.getRow(totalRow).height=20;

      // ---------- تعداد دانش‌آموزان خاص ----------
      let sr=totalRow+2;
      ws1.mergeCells(sr,1,sr,8);
      ws1.getCell(sr,1).value='تعداد دانش‌آموزان خاص';
      ws1.getCell(sr,1).font={size:12,bold:true,color:{argb:'FFFFFFFF'}};
      ws1.getCell(sr,1).fill=groupFill;
      ws1.getCell(sr,1).alignment={horizontal:'center',vertical:'middle'};
      ws1.getRow(sr).height=20;
      sr++;
      const specialLabels=['فرزندان شاهد','تلفیقی شدید','تلفیقی خفیف','تحت پوشش','اتباع خارجی','جذب بازمانده'];
      specialLabels.forEach((lab,idx)=>{
        const rr=sr+idx;
        ws1.getCell(rr,1).value=lab+':';
        ws1.getCell(rr,1).font={bold:true};
        ws1.getCell(rr,1).alignment={horizontal:'right',vertical:'middle'};
        ws1.getCell(rr,1).border=borderAll;
        ws1.getCell(rr,2).value=numOrBlank(orgData.special[idx]);
        ws1.getCell(rr,2).fill=inputFill;
        ws1.getCell(rr,2).border=borderAll;
        ws1.getCell(rr,2).alignment={horizontal:'center',vertical:'middle'};
        ws1.getRow(rr).height=19;
      });

      addSignatureFooter(ws1,1,8,sr+specialLabels.length-1);

      ws1.getColumn(1).width=17;
      for(let c=2;c<=8;c++)ws1.getColumn(c).width=11;

      // ---------- شیت ۲: اطلاعات پرسنل ----------
      const ws2=wb.addWorksheet('اطلاعات پرسنل',{views:[{rightToLeft:true,state:'frozen',ySplit:1}],pageSetup:{paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,margins:{left:0.3,right:0.3,top:0.4,bottom:0.4,header:0.2,footer:0.2},horizontalCentered:true}});
      const headers2=['ردیف','کد پرسنلی','نام','نام خانوادگی','کد ملی','مدرک','رشته تحصیلی','سابقه','نوع استخدام / وضعیت','پست سازمانی','آدرس','تلفن'];
      const hdrRow2=ws2.getRow(1);
      headers2.forEach((t,i)=>{hdrRow2.getCell(i+1).value=t;});
      hdrRow2.eachCell(function(cell){
        cell.font={bold:true,color:{argb:'FFFFFFFF'}};
        cell.fill=groupFill;
        cell.alignment={horizontal:'center',vertical:'middle',wrapText:true};
        cell.border=borderAll;
      });
      hdrRow2.height=26;

      const staffRowCount=Math.max(orgData.staff.length,20);
      for(let rr=2;rr<=staffRowCount+1;rr++){
        const rowVals=orgData.staff[rr-2]||[];
        ws2.getCell(rr,1).value={formula:'ROW()-1'};
        for(let c=1;c<=12;c++){
          const cell=ws2.getCell(rr,c);
          cell.border=borderAll;
          cell.alignment={horizontal:'center',vertical:'middle'};
          if(c!==1){cell.fill=inputFill;cell.value=rowVals[c-2]||'';}
        }
      }
      ws2.autoFilter={from:{row:1,column:1},to:{row:1,column:12}};
      addSignatureFooter(ws2,1,12,staffRowCount+1);
      ws2.getColumn(1).width=7;
      ws2.getColumn(2).width=14;
      ws2.getColumn(3).width=12;
      ws2.getColumn(4).width=14;
      ws2.getColumn(5).width=12;
      ws2.getColumn(6).width=11;
      ws2.getColumn(7).width=13;
      ws2.getColumn(8).width=8;
      ws2.getColumn(9).width=15;
      ws2.getColumn(10).width=13;
      ws2.getColumn(11).width=18;
      ws2.getColumn(12).width=13;

      // ---------- شیت ۳: ساعات موظف / غیرموظف به تفکیک پایه ----------
      const ws3=wb.addWorksheet('ساعات موظف',{views:[{rightToLeft:true,state:'frozen',ySplit:2}],pageSetup:{paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,margins:{left:0.25,right:0.25,top:0.35,bottom:0.35,header:0.15,footer:0.15},horizontalCentered:true}});
      const hg1=1,hg2=2;
      ws3.mergeCells(hg1,1,hg2,1); ws3.getCell(hg1,1).value='ردیف';
      ws3.mergeCells(hg1,2,hg2,2); ws3.getCell(hg1,2).value='کد پرسنلی';
      ws3.mergeCells(hg1,3,hg2,3); ws3.getCell(hg1,3).value='نام و نام خانوادگی';
      const hourGroups=['پایه اول','پایه دوم','پایه سوم','پایه چهارم','پایه پنجم','پایه ششم','چندپایه','جمع'];
      hourGroups.forEach((gname,gi)=>{
        const c0=4+gi*3;
        ws3.mergeCells(hg1,c0,hg1,c0+2);
        ws3.getCell(hg1,c0).value=gname;
        ws3.getCell(hg2,c0).value='موظف';
        ws3.getCell(hg2,c0+1).value='غ‌موظف';
        ws3.getCell(hg2,c0+2).value='جمع';
      });
      const lastCol=4+hourGroups.length*3-1;
      for(let rr=hg1;rr<=hg2;rr++){
        ws3.getRow(rr).eachCell({includeEmpty:true},function(cell,colNum){
          if(colNum>lastCol)return;
          cell.font={bold:true,color:{argb:'FF1E3A8A'}};
          cell.fill=headerFill;
          cell.alignment={horizontal:'center',vertical:'middle',wrapText:true};
          cell.border=borderAll;
        });
        ws3.getRow(rr).height=20;
      }
      const gradeGroupCount=7; // پایه اول..ششم + چندپایه (گروه هشتم «جمع» خودش محاسبه‌شونده است)
      const hoursRowCount=Math.max(orgData.hours.length,15);
      for(let idx=0;idx<hoursRowCount;idx++){
        const rr=hg2+1+idx;
        const hrow=orgData.hours[idx]||{code:'',name:'',g:[]};
        ws3.getCell(rr,1).value={formula:'ROW()-'+(hg2)};
        ws3.getCell(rr,2).value=hrow.code||'';
        ws3.getCell(rr,3).value=hrow.name||'';
        const moColLetters=[],ghColLetters=[];
        for(let gi=0;gi<gradeGroupCount;gi++){
          const c0=4+gi*3;
          const pair=hrow.g[gi]||{};
          ws3.getCell(rr,c0).value=numOrBlank(pair.mo);
          ws3.getCell(rr,c0+1).value=numOrBlank(pair.gh);
          ws3.getCell(rr,c0+2).value={formula:colLetter(c0)+rr+'+'+colLetter(c0+1)+rr};
          moColLetters.push(colLetter(c0));ghColLetters.push(colLetter(c0+1));
        }
        const finalC0=4+gradeGroupCount*3;
        ws3.getCell(rr,finalC0).value={formula:moColLetters.map(cl=>cl+rr).join('+')};
        ws3.getCell(rr,finalC0+1).value={formula:ghColLetters.map(cl=>cl+rr).join('+')};
        ws3.getCell(rr,finalC0+2).value={formula:colLetter(finalC0)+rr+'+'+colLetter(finalC0+1)+rr};
        ws3.getRow(rr).eachCell({includeEmpty:true},function(cell,colNum){
          if(colNum>lastCol)return;
          cell.border=borderAll;
          cell.alignment={horizontal:'center',vertical:'middle'};
          if(colNum>3)cell.fill=inputFill;
        });
        ws3.getRow(rr).height=19;
      }
      addSignatureFooter(ws3,1,lastCol,hg2+hoursRowCount);
      ws3.getColumn(1).width=7;
      ws3.getColumn(2).width=13;
      ws3.getColumn(3).width=20;
      for(let c=4;c<=lastCol;c++)ws3.getColumn(c).width=8;

      const buf=await wb.xlsx.writeBuffer();
      const blob=new Blob([buf],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='فرم-سازمان-عملی.xlsx';document.body.appendChild(a);a.click();a.remove();
      toast('فرم سازمان عملی ساخته شد ✅');
    }catch(err){
      toast('خطا در ساخت فایل — اتصال اینترنت را بررسی کنید');
    }finally{
      btn.disabled=false;btn.textContent=origText;
    }
  };


  // ===== اسکنر =====
  let SCANIMG=null, SCANORIG=null, scanRotation=0;
  const scanDropZone=document.getElementById('scan-drop-zone');
  const scanFileInput=document.getElementById('scan-file');
  scanDropZone.onclick=()=>scanFileInput.click();
  scanDropZone.addEventListener('dragover',e=>{e.preventDefault();scanDropZone.classList.add('dragover');});
  scanDropZone.addEventListener('dragleave',()=>scanDropZone.classList.remove('dragover'));
  scanDropZone.addEventListener('drop',e=>{e.preventDefault();scanDropZone.classList.remove('dragover');if(e.dataTransfer.files[0])loadScanImg(e.dataTransfer.files[0]);});
  scanFileInput.addEventListener('change',function(){if(this.files[0])loadScanImg(this.files[0]);});

  function loadScanImg(file){
    const rd=new FileReader();
    rd.onload=ev=>{const img=new Image();img.onload=()=>{
      // عکس‌های دوربین موبایل معمولاً خیلی بزرگ‌اند (۸ تا ۱۲+ مگاپیکسل)؛ پردازش‌های بعدی (اصلاح پرسپکتیو، فیلترها، برش)
      // پیکسل‌به‌پیکسل روی کل تصویر انجام می‌شوند و بدون کوچک‌سازی ممکن است مرورگر موبایل هنگ کند یا کاملاً بسته شود.
      const maxDim=2000;
      let w=img.naturalWidth,h=img.naturalHeight;
      if(Math.max(w,h)>maxDim){
        const scale=maxDim/Math.max(w,h);
        const c=document.createElement('canvas');
        c.width=Math.round(w*scale);c.height=Math.round(h*scale);
        c.getContext('2d').drawImage(img,0,0,c.width,c.height);
        const resized=new Image();
        resized.onload=()=>{
          scanDropZone.classList.add('hidden');
          scanWarpOriginalImg=resized;
          openScanWarpStage(resized);
        };
        resized.onerror=()=>{toast('خطا در پردازش عکس');};
        resized.src=c.toDataURL('image/jpeg',0.92);
        return;
      }
      scanDropZone.classList.add('hidden');
      scanWarpOriginalImg=img;
      openScanWarpStage(img);
    };img.onerror=()=>{toast('فایل عکس معتبر نیست');};img.src=ev.target.result;};
    rd.onerror=()=>{toast('خطا در خواندن فایل');};
    rd.readAsDataURL(file);
  }

  // ===== برش پرسپکتیو (صاف‌کردن سند مثل CamScanner) =====
  let scanWarpOriginalImg=null;
  let scanWarpCorners={tl:{x:0.08,y:0.08},tr:{x:0.92,y:0.08},br:{x:0.92,y:0.92},bl:{x:0.08,y:0.92}};

  function openScanWarpStage(img){
    document.getElementById('scan-warp-img').src=img.src;
    document.getElementById('scan-warp-stage').classList.remove('hidden');
    document.getElementById('scan-controls').classList.add('hidden');
    scanWarpCorners={tl:{x:0.08,y:0.08},tr:{x:0.92,y:0.08},br:{x:0.92,y:0.92},bl:{x:0.08,y:0.92}};
    scanRenderWarpHandles();
  }

  function scanRenderWarpHandles(){
    const wrapper=document.getElementById('scan-warp-wrapper');
    ['tl','tr','br','bl'].forEach(k=>{
      const h=wrapper.querySelector('.scan-warp-handle[data-corner="'+k+'"]');
      h.style.left=(scanWarpCorners[k].x*100)+'%';
      h.style.top=(scanWarpCorners[k].y*100)+'%';
    });
    const pts=['tl','tr','br','bl'].map(k=>(scanWarpCorners[k].x*100)+'%,'+(scanWarpCorners[k].y*100)+'%').join(' ');
    document.getElementById('scan-warp-poly').setAttribute('points',pts);
  }

  function scanMakeDraggable(handle,corner){
    handle.addEventListener('pointerdown',e=>{
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const wrapper=document.getElementById('scan-warp-wrapper');
      function move(ev){
        const rect=wrapper.getBoundingClientRect();
        let px=(ev.clientX-rect.left)/rect.width, py=(ev.clientY-rect.top)/rect.height;
        px=Math.min(1,Math.max(0,px));py=Math.min(1,Math.max(0,py));
        scanWarpCorners[corner]={x:px,y:py};
        scanRenderWarpHandles();
      }
      function up(){
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener('pointermove',move);
        handle.removeEventListener('pointerup',up);
      }
      handle.addEventListener('pointermove',move);
      handle.addEventListener('pointerup',up);
    });
  }
  document.querySelectorAll('.scan-warp-handle').forEach(h=>scanMakeDraggable(h,h.dataset.corner));

  // تشخیص تقریبیِ لبه‌های سند (بر پایهٔ تغییرات شدید رنگ/روشنایی نسبت به پس‌زمینه)
  function scanAutoDetectEdges(img){
    const maxDim=400;
    const w=img.naturalWidth,h=img.naturalHeight;
    const scale=Math.min(1,maxDim/Math.max(w,h));
    const cw=Math.max(2,Math.round(w*scale)),ch=Math.max(2,Math.round(h*scale));
    const cv=document.createElement('canvas');cv.width=cw;cv.height=ch;
    const ctx=cv.getContext('2d');ctx.drawImage(img,0,0,cw,ch);
    const d=ctx.getImageData(0,0,cw,ch).data;
    const gray=new Float32Array(cw*ch);
    for(let i=0;i<cw*ch;i++){const p=i*4;gray[i]=0.299*d[p]+0.587*d[p+1]+0.114*d[p+2];}
    const rowScore=new Float32Array(ch),colScore=new Float32Array(cw);
    for(let y=1;y<ch-1;y++){
      for(let x=1;x<cw-1;x++){
        const gx=gray[y*cw+x+1]-gray[y*cw+x-1];
        const gy=gray[(y+1)*cw+x]-gray[(y-1)*cw+x];
        const mag=Math.abs(gx)+Math.abs(gy);
        rowScore[y]+=mag;colScore[x]+=mag;
      }
    }
    let rMax=0,cMax=0;
    for(let i=0;i<ch;i++)if(rowScore[i]>rMax)rMax=rowScore[i];
    for(let i=0;i<cw;i++)if(colScore[i]>cMax)cMax=colScore[i];
    const rThresh=rMax*0.15,cThresh=cMax*0.15;
    let top=0,bottom=ch-1,left=0,right=cw-1;
    for(let y=0;y<ch;y++){if(rowScore[y]>rThresh){top=y;break;}}
    for(let y=ch-1;y>=0;y--){if(rowScore[y]>rThresh){bottom=y;break;}}
    for(let x=0;x<cw;x++){if(colScore[x]>cThresh){left=x;break;}}
    for(let x=cw-1;x>=0;x--){if(colScore[x]>cThresh){right=x;break;}}
    if(right-left<cw*0.2||bottom-top<ch*0.2)return null; // تشخیص نامطمئن بود
    return{left:left/cw,top:top/ch,right:right/cw,bottom:bottom/ch};
  }

  document.getElementById('btn-scan-autodetect').onclick=()=>{
    if(!scanWarpOriginalImg)return;
    const box=scanAutoDetectEdges(scanWarpOriginalImg);
    if(!box){toast('تشخیص خودکار مطمئن نبود — لطفاً گوشه‌ها را دستی تنظیم کنید');return;}
    scanWarpCorners={tl:{x:box.left,y:box.top},tr:{x:box.right,y:box.top},br:{x:box.right,y:box.bottom},bl:{x:box.left,y:box.bottom}};
    scanRenderWarpHandles();
    toast('لبه‌های سند تشخیص داده شد — در صورت نیاز گوشه‌ها را دقیق‌تر کنید');
  };

  // محاسبهٔ ماتریس هوموگرافی (تبدیل پرسپکتیو) از ۴ نقطهٔ متناظر
  function scanComputeHomography(from,to){
    const A=[],n=8;
    for(let i=0;i<4;i++){
      const{x,y}=from[i],X=to[i].x,Y=to[i].y;
      A.push([x,y,1,0,0,0,-x*X,-y*X,X]);
      A.push([0,0,0,x,y,1,-x*Y,-y*Y,Y]);
    }
    for(let col=0;col<n;col++){
      let maxRow=col;
      for(let r=col+1;r<n;r++)if(Math.abs(A[r][col])>Math.abs(A[maxRow][col]))maxRow=r;
      const tmp=A[col];A[col]=A[maxRow];A[maxRow]=tmp;
      const pivot=A[col][col];
      if(Math.abs(pivot)<1e-12)continue;
      for(let r=0;r<n;r++){
        if(r===col)continue;
        const factor=A[r][col]/pivot;
        for(let c=col;c<=n;c++)A[r][c]-=factor*A[col][c];
      }
    }
    const hArr=new Array(n);
    for(let i=0;i<n;i++)hArr[i]=A[i][n]/A[i][i];
    return hArr;
  }

  function scanWarpPerspective(img,srcCorners,outW,outH){
    const srcCanvas=document.createElement('canvas');
    srcCanvas.width=img.naturalWidth;srcCanvas.height=img.naturalHeight;
    const sctx=srcCanvas.getContext('2d');sctx.drawImage(img,0,0);
    const sw=srcCanvas.width,sh=srcCanvas.height;
    const srcData=sctx.getImageData(0,0,sw,sh).data;
    const dst=[{x:0,y:0},{x:outW,y:0},{x:outW,y:outH},{x:0,y:outH}];
    const h=scanComputeHomography(dst,srcCorners);
    const outCanvas=document.createElement('canvas');
    outCanvas.width=outW;outCanvas.height=outH;
    const octx=outCanvas.getContext('2d');
    const outImgData=octx.createImageData(outW,outH);
    const od=outImgData.data;
    for(let Y=0;Y<outH;Y++){
      for(let X=0;X<outW;X++){
        const denom=h[6]*X+h[7]*Y+1;
        const sx=(h[0]*X+h[1]*Y+h[2])/denom;
        const sy=(h[3]*X+h[4]*Y+h[5])/denom;
        const oi=(Y*outW+X)*4;
        if(sx<0||sy<0||sx>=sw-1||sy>=sh-1){od[oi]=255;od[oi+1]=255;od[oi+2]=255;od[oi+3]=255;continue;}
        const x0=Math.floor(sx),y0=Math.floor(sy),fx=sx-x0,fy=sy-y0;
        const i00=(y0*sw+x0)*4,i10=(y0*sw+x0+1)*4,i01=((y0+1)*sw+x0)*4,i11=((y0+1)*sw+x0+1)*4;
        for(let c=0;c<3;c++){
          const top=srcData[i00+c]*(1-fx)+srcData[i10+c]*fx;
          const bot=srcData[i01+c]*(1-fx)+srcData[i11+c]*fx;
          od[oi+c]=top*(1-fy)+bot*fy;
        }
        od[oi+3]=255;
      }
    }
    octx.putImageData(outImgData,0,0);
    return outCanvas;
  }

  function scanFinishToFilterStage(img){
    SCANIMG=img;SCANORIG=img;scanRotation=0;
    document.getElementById('scan-warp-stage').classList.add('hidden');
    document.getElementById('scan-controls').classList.remove('hidden');
    applyScan();
  }

  document.getElementById('btn-scan-warp-skip').onclick=()=>{
    scanFinishToFilterStage(scanWarpOriginalImg);
  };

  document.getElementById('btn-scan-warp-apply').onclick=async()=>{
    if(!scanWarpOriginalImg)return;
    const btn=document.getElementById('btn-scan-warp-apply');const origText=btn.textContent;
    btn.disabled=true;btn.textContent='⏳ در حال صاف‌کردن...';
    await new Promise(r=>setTimeout(r,30)); // فرصت برای رندر لودینگ
    try{
      const img=scanWarpOriginalImg;
      const iw=img.naturalWidth,ih=img.naturalHeight;
      const src=['tl','tr','br','bl'].map(k=>({x:scanWarpCorners[k].x*iw,y:scanWarpCorners[k].y*ih}));
      const wTop=Math.hypot(src[1].x-src[0].x,src[1].y-src[0].y);
      const wBot=Math.hypot(src[2].x-src[3].x,src[2].y-src[3].y);
      const hLeft=Math.hypot(src[3].x-src[0].x,src[3].y-src[0].y);
      const hRight=Math.hypot(src[2].x-src[1].x,src[2].y-src[1].y);
      const outW=Math.round(Math.max(wTop,wBot));
      const outH=Math.round(Math.max(hLeft,hRight));
      const canvas=scanWarpPerspective(img,src,outW,outH);
      const flatImg=new Image();
      flatImg.onload=()=>{scanFinishToFilterStage(flatImg);btn.disabled=false;btn.textContent=origText;};
      flatImg.src=canvas.toDataURL('image/png');
    }catch(e){
      toast('خطا در صاف‌کردن سند');btn.disabled=false;btn.textContent=origText;
    }
  };

  document.getElementById('btn-rescan-warp').onclick=()=>{
    if(!scanWarpOriginalImg)return;
    openScanWarpStage(scanWarpOriginalImg);
  };

  document.getElementById('scan-out-quality').addEventListener('input',function(){document.getElementById('scan-out-quality-val').textContent=this.value+'%';});

  const FILTERS={
    original:()=>{document.getElementById('scan-bright').value=0;document.getElementById('scan-contrast').value=0;document.getElementById('scan-saturation').value=0;document.getElementById('scan-sharp').value=0;},
    color:()=>{document.getElementById('scan-bright').value=5;document.getElementById('scan-contrast').value=10;document.getElementById('scan-saturation').value=15;document.getElementById('scan-sharp').value=20;},
    gray:()=>{document.getElementById('scan-bright').value=10;document.getElementById('scan-contrast').value=20;document.getElementById('scan-saturation').value=-100;document.getElementById('scan-sharp').value=30;},
    bw:()=>{document.getElementById('scan-bright').value=30;document.getElementById('scan-contrast').value=50;document.getElementById('scan-saturation').value=-100;document.getElementById('scan-sharp').value=40;},
    document:()=>{document.getElementById('scan-bright').value=20;document.getElementById('scan-contrast').value=40;document.getElementById('scan-saturation').value=-80;document.getElementById('scan-sharp').value=50;},
    enhance:()=>{document.getElementById('scan-bright').value=10;document.getElementById('scan-contrast').value=30;document.getElementById('scan-saturation').value=10;document.getElementById('scan-sharp').value=40;},
    textoenhance:()=>{document.getElementById('scan-bright').value=15;document.getElementById('scan-contrast').value=50;document.getElementById('scan-saturation').value=-100;document.getElementById('scan-sharp').value=60;},
    removeshadow:()=>{document.getElementById('scan-bright').value=25;document.getElementById('scan-contrast').value=35;document.getElementById('scan-saturation').value=-50;document.getElementById('scan-sharp').value=30;},
    whitenbg:()=>{document.getElementById('scan-bright').value=30;document.getElementById('scan-contrast').value=45;document.getElementById('scan-saturation').value=-100;document.getElementById('scan-sharp').value=40;}
  };

  document.querySelectorAll('.filter-btn').forEach(btn=>{
    btn.onclick=()=>{document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');if(FILTERS[btn.dataset.filter])FILTERS[btn.dataset.filter]();updateFilterValues();applyScan();};
  });

  function updateFilterValues(){
    document.getElementById('bright-val').textContent=document.getElementById('scan-bright').value;
    document.getElementById('contrast-val').textContent=document.getElementById('scan-contrast').value;
    document.getElementById('sharp-val').textContent=document.getElementById('scan-sharp').value;
    document.getElementById('saturation-val').textContent=document.getElementById('scan-saturation').value;
  }

  ['scan-bright','scan-contrast','scan-sharp','scan-saturation'].forEach(id=>{const el=document.getElementById(id);if(el)el.addEventListener('input',()=>{updateFilterValues();applyScan();});});

  function applyScan(){
    if(!SCANORIG)return;
    scanRotation=(scanRotation%4+4)%4;
    const cv=document.getElementById('scan-canvas');const ctx=cv.getContext('2d');
    const mw=1400;let w=SCANORIG.width,h=SCANORIG.height;if(w>mw){h=Math.round(h*mw/w);w=mw;}
    if(scanRotation===1||scanRotation===3){cv.width=h;cv.height=w;}else{cv.width=w;cv.height=h;}
    ctx.save();
    if(scanRotation===1)ctx.translate(cv.width,0);
    if(scanRotation===2)ctx.translate(cv.width,cv.height);
    if(scanRotation===3)ctx.translate(0,cv.height);
    ctx.rotate(scanRotation*Math.PI/2);
    ctx.drawImage(SCANORIG,0,0,w,h);
    ctx.restore();
    const cw=cv.width, ch=cv.height;
    const bright=parseInt(document.getElementById('scan-bright').value,10);
    const contrast=parseInt(document.getElementById('scan-contrast').value,10);
    const sharp=parseInt(document.getElementById('scan-sharp').value,10)/100;
    const sat=parseInt(document.getElementById('scan-saturation').value,10)/100+1;
    let im=ctx.getImageData(0,0,cw,ch);let d=im.data;
    if(sat!==1){for(let p=0;p<d.length;p+=4){const gray=0.299*d[p]+0.587*d[p+1]+0.114*d[p+2];d[p]=Math.min(255,Math.max(0,gray+sat*(d[p]-gray)));d[p+1]=Math.min(255,Math.max(0,gray+sat*(d[p+1]-gray)));d[p+2]=Math.min(255,Math.max(0,gray+sat*(d[p+2]-gray)));}ctx.putImageData(im,0,0);im=ctx.getImageData(0,0,cw,ch);d=im.data;}
    const factor=(259*(contrast+255))/(255*(259-contrast));
    for(let p=0;p<d.length;p+=4){for(let c=0;c<3;c++){let val=d[p+c];val=factor*(val-128)+128+bright;d[p+c]=Math.min(255,Math.max(0,val));}}
    ctx.putImageData(im,0,0);
    if(sharp>0){im=ctx.getImageData(0,0,cw,ch);const tmp=ctx.createImageData(cw,ch);const kernel=[0,-sharp,0,-sharp,1+4*sharp,-sharp,0,-sharp,0];for(let y=1;y<ch-1;y++){for(let x=1;x<cw-1;x++){for(let c=0;c<3;c++){let sum=0;for(let ky=-1;ky<=1;ky++){for(let kx=-1;kx<=1;kx++){const idx=((y+ky)*cw+(x+kx))*4+c;sum+=im.data[idx]*kernel[(ky+1)*3+(kx+1)];}}tmp.data[(y*cw+x)*4+c]=Math.min(255,Math.max(0,sum));}tmp.data[(y*cw+x)*4+3]=255;}}ctx.putImageData(tmp,0,0);}
  }

  document.getElementById('btn-rotate-l').onclick=()=>{if(!SCANORIG){toast('ابتدا عکس را انتخاب کنید');return;}scanRotation--;applyScan();};
  document.getElementById('btn-rotate-r').onclick=()=>{if(!SCANORIG){toast('ابتدا عکس را انتخاب کنید');return;}scanRotation++;applyScan();};

  // ===== روشن‌سازی خودکار (شبیه حالت Auto در CamScanner) =====
  // با تحلیل هیستوگرام روشنایی تصویر، بازه واقعی روشنایی را پیدا کرده و مستقیماً (بدون محدودیت اسلایدرها) آن را به بازهٔ کامل ۰ تا ۲۵۵ کش می‌دهد
  document.getElementById('btn-scan-autoenhance').onclick=()=>{
    if(!SCANORIG){toast('ابتدا عکس را انتخاب کنید');return;}
    const mw=300;
    let w=SCANORIG.width,h=SCANORIG.height;
    const scale=Math.min(1,mw/Math.max(w,h));
    const sw=Math.max(2,Math.round(w*scale)),sh=Math.max(2,Math.round(h*scale));
    const tmp=document.createElement('canvas');tmp.width=sw;tmp.height=sh;
    const tctx=tmp.getContext('2d');tctx.drawImage(SCANORIG,0,0,sw,sh);
    const data=tctx.getImageData(0,0,sw,sh).data;
    const hist=new Array(256).fill(0);
    let total=0;
    for(let i=0;i<data.length;i+=4){
      const lum=Math.round(0.299*data[i]+0.587*data[i+1]+0.114*data[i+2]);
      hist[lum]++;total++;
    }
    const lowCut=total*0.02,highCutFromTop=total*0.02;
    let cum=0,lowP=0,highP=255;
    for(let v=0;v<256;v++){cum+=hist[v];if(cum>=lowCut){lowP=v;break;}}
    cum=0;
    for(let v=255;v>=0;v--){cum+=hist[v];if(cum>=highCutFromTop){highP=v;break;}}
    if(highP-lowP<20){toast('تصویر نیازی به بهبود خودکار ندارد');return;}
    const a=255/(highP-lowP);
    const b=-a*lowP;
    // این ضرایب مستقیماً روی تصویر اصلی اعمال می‌شوند (بدون واسطهٔ اسلایدرهای روشنایی/کنتراست که ممکن است رنجشان کافی نباشد)
    const fullCanvas=document.createElement('canvas');
    fullCanvas.width=SCANORIG.width;fullCanvas.height=SCANORIG.height;
    const fctx=fullCanvas.getContext('2d');
    fctx.drawImage(SCANORIG,0,0);
    const im=fctx.getImageData(0,0,fullCanvas.width,fullCanvas.height);const d=im.data;
    for(let p=0;p<d.length;p+=4){
      d[p]=Math.min(255,Math.max(0,a*d[p]+b));
      d[p+1]=Math.min(255,Math.max(0,a*d[p+1]+b));
      d[p+2]=Math.min(255,Math.max(0,a*d[p+2]+b));
    }
    fctx.putImageData(im,0,0);
    const enhancedImg=new Image();
    enhancedImg.onload=()=>{
      SCANORIG=enhancedImg;SCANIMG=enhancedImg;
      document.getElementById('scan-bright').value=0;
      document.getElementById('scan-contrast').value=0;
      document.querySelectorAll('.filter-btn').forEach(fb=>fb.classList.remove('active'));
      updateFilterValues();
      applyScan();
      toast('روشنایی تصویر به‌صورت خودکار بهبود یافت ✅');
    };
    enhancedImg.src=fullCanvas.toDataURL('image/png');
  };

  document.getElementById('btn-reset-scan').onclick=()=>{SCANORIG=SCANIMG;scanRotation=0;document.getElementById('scan-bright').value=0;document.getElementById('scan-contrast').value=0;document.getElementById('scan-sharp').value=0;document.getElementById('scan-saturation').value=0;updateFilterValues();document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));document.querySelector('.filter-btn[data-filter="original"]').classList.add('active');applyScan();};
  document.getElementById('btn-remove-scan').onclick=()=>{if(!confirm('عکس فعلی حذف شود؟'))return;SCANIMG=null;SCANORIG=null;scanWarpOriginalImg=null;scanRotation=0;document.getElementById('scan-controls').classList.add('hidden');document.getElementById('scan-warp-stage').classList.add('hidden');document.getElementById('scan-drop-zone').classList.remove('hidden');document.getElementById('scan-file').value='';document.getElementById('scan-bright').value=0;document.getElementById('scan-contrast').value=0;document.getElementById('scan-sharp').value=0;document.getElementById('scan-saturation').value=0;updateFilterValues();document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));document.querySelector('.filter-btn[data-filter="original"]').classList.add('active');};
  document.getElementById('btn-dl-img').onclick=()=>{if(!SCANORIG){toast('ابتدا عکس را انتخاب کنید');return;}const cv=document.getElementById('scan-canvas');const q=parseInt(document.getElementById('scan-out-quality').value,10)/100;cv.toBlob(blob=>{const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='اسکن.jpg';document.body.appendChild(a);a.click();a.remove();toast('عکس دانلود شد ✅ (حجم فایل حدود '+(blob.size/1024).toFixed(0)+' کیلوبایت)');},'image/jpeg',q);};
  document.getElementById('btn-dl-pdf').onclick=()=>{if(!SCANORIG){toast('ابتدا عکس را انتخاب کنید');return;}if(!window.jspdf){toast('کتابخانه PDF در دسترس نیست');return;}const cv=document.getElementById('scan-canvas');const img=cv.toDataURL('image/jpeg',0.92);const jsPDF=window.jspdf.jsPDF;const pdf=new jsPDF({orientation:cv.width>=cv.height?'l':'p',unit:'pt',format:'a4'});const pw=pdf.internal.pageSize.getWidth(),ph=pdf.internal.pageSize.getHeight();const m=24,aw=pw-2*m,ah=ph-2*m;let iw=cv.width,ih=cv.height;const ratio=Math.min(aw/iw,ah/ih);iw*=ratio;ih*=ratio;pdf.addImage(img,'JPEG',(pw-iw)/2,(ph-ih)/2,iw,ih);pdf.save('اسکن.pdf');toast('فایل PDF ساخته شد ✅');};

  // ===== کاهش حجم =====
  const resizeDropZone=document.getElementById('resize-drop-zone');
  const resizeFileInput=document.getElementById('resize-file');
  resizeDropZone.onclick=()=>resizeFileInput.click();
  resizeDropZone.addEventListener('dragover',e=>{e.preventDefault();resizeDropZone.classList.add('dragover');});
  resizeDropZone.addEventListener('dragleave',()=>resizeDropZone.classList.remove('dragover'));
  resizeDropZone.addEventListener('drop',e=>{e.preventDefault();resizeDropZone.classList.remove('dragover');handleResizeFiles(e.dataTransfer.files);});
  resizeFileInput.addEventListener('change',function(){handleResizeFiles(this.files);});

  function handleResizeFiles(files){
    Array.from(files).forEach(file=>{
      if(!file.type.startsWith('image/')){toast('فایل «'+file.name+'» عکس نیست و نادیده گرفته شد');return;}
      const rd=new FileReader();
      rd.onload=ev=>{
        const img=new Image();
        img.onload=()=>{RESIZE_IMAGES.push({file,img,original:ev.target.result});document.getElementById('resize-controls').classList.remove('hidden');renderResizePreview();};
        img.onerror=()=>{toast('فایل «'+file.name+'» قابل بازکردن نیست');};
        img.src=ev.target.result;
      };
      rd.onerror=()=>{toast('خطا در خواندن فایل «'+file.name+'»');};
      rd.readAsDataURL(file);
    });
  }

  function renderResizePreview(){
    const box=document.getElementById('resize-preview');
    if(!RESIZE_IMAGES.length){box.innerHTML='';updateTotalInfo();return;}
    box.innerHTML=RESIZE_IMAGES.map((r,i)=>{
      const origSize=(r.file.size/1024).toFixed(1);
      return '<div class="resize-item"><button class="remove-btn" onclick="removeResizeImg('+i+')">×</button><img src="'+r.original+'" alt=""><div class="size-info">'+origSize+' KB<br>'+r.img.width+'×'+r.img.height+'</div></div>';
    }).join('');
    updateTotalInfo();
  }
  window.removeResizeImg=(i)=>{RESIZE_IMAGES.splice(i,1);renderResizePreview();if(!RESIZE_IMAGES.length)document.getElementById('resize-controls').classList.add('hidden');};

  function updateTotalInfo(){
    const el=document.getElementById('total-original-size');const nel=document.getElementById('total-new-size');const rel=document.getElementById('total-reduction');
    if(!el||!nel||!rel)return;
    if(!RESIZE_IMAGES.length){el.textContent='-';nel.textContent='-';rel.textContent='-';return;}
    const totalOrig=RESIZE_IMAGES.reduce((s,r)=>s+r.file.size,0);
    el.textContent=(totalOrig/1024/1024).toFixed(2)+' MB';
    const q=parseInt(document.getElementById('resize-quality').value,10)/100;
    const fmt=document.querySelector('.format-btn.active')?.dataset.format||'jpeg';
    let estNew=totalOrig*q*0.7;
    nel.textContent=(estNew/1024/1024).toFixed(2)+' MB';
    const reduction=Math.round((1-estNew/totalOrig)*100);
    rel.textContent=reduction+'٪ کاهش';
  }

  document.getElementById('resize-quality').addEventListener('input',function(){
    const q=parseInt(this.value,10);
    document.getElementById('quality-percent').textContent=q+'%';
    const avgSize=RESIZE_IMAGES.length?RESIZE_IMAGES.reduce((s,r)=>s+r.file.size,0)/RESIZE_IMAGES.length:500000;
    const est=Math.round(avgSize*(q/100));
    document.getElementById('quality-estimate').textContent='حدود '+(est/1024).toFixed(0)+' KB';
    updateTotalInfo();
  });

  document.querySelectorAll('.format-btn').forEach(btn=>{btn.onclick=()=>{document.querySelectorAll('.format-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');updateTotalInfo();};});
  document.querySelectorAll('input[name="resize-size"]').forEach(radio=>{radio.addEventListener('change',updateTotalInfo);});

  function computeResizedBlob(r,fmt,mime,q,sizeOpt){
    return new Promise((resolve)=>{
      let w=r.img.width,h=r.img.height;
      if(sizeOpt!=='original'){const maxSize=parseInt(sizeOpt);if(w>maxSize||h>maxSize){const ratio=Math.min(maxSize/w,maxSize/h);w=Math.round(w*ratio);h=Math.round(h*ratio);}}
      const cv=document.createElement('canvas');cv.width=w;cv.height=h;const ctx=cv.getContext('2d');ctx.drawImage(r.img,0,0,w,h);
      cv.toBlob(blob=>resolve({blob,w,h}),mime,q);
    });
  }
  function getResizeSettings(){
    const q=parseInt(document.getElementById('resize-quality').value,10)/100;
    const fmt=document.querySelector('.format-btn.active').dataset.format;
    const sizeOpt=document.querySelector('input[name="resize-size"]:checked').value;
    const mime=fmt==='png'?'image/png':fmt==='webp'?'image/webp':'image/jpeg';
    const ext=fmt==='png'?'png':fmt==='webp'?'webp':'jpg';
    return {q,fmt,sizeOpt,mime,ext};
  }

  document.getElementById('btn-resize-all').onclick=async()=>{
    if(!RESIZE_IMAGES.length){toast('ابتدا عکس انتخاب کنید');return;}
    const {q,mime,ext,sizeOpt}=getResizeSettings();
    let failCount=0;
    for(let i=0;i<RESIZE_IMAGES.length;i++){
      const {blob,w,h}=await computeResizedBlob(RESIZE_IMAGES[i],null,mime,q,sizeOpt);
      if(!blob){failCount++;continue;}
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='عکس_'+(i+1)+'_'+w+'x'+h+'.'+ext;document.body.appendChild(a);a.click();a.remove();
    }
    toast(failCount?('برخی عکس‌ها ('+failCount+') با خطا مواجه شدند'):'عکس‌ها با موفقیت فشرده شدند ✅');
  };

  document.getElementById('btn-resize-zip').onclick=async()=>{
    if(!RESIZE_IMAGES.length){toast('ابتدا عکس انتخاب کنید');return;}
    if(!window.JSZip){toast('کتابخانه ZIP در دسترس نیست');return;}
    const btn=document.getElementById('btn-resize-zip');btn.disabled=true;const origText=btn.textContent;btn.textContent='⏳ در حال ساخت ZIP...';
    try{
      const {q,mime,ext,sizeOpt}=getResizeSettings();
      const zip=new JSZip();
      let failCount=0;
      for(let i=0;i<RESIZE_IMAGES.length;i++){
        const {blob,w,h}=await computeResizedBlob(RESIZE_IMAGES[i],null,mime,q,sizeOpt);
        if(!blob){failCount++;continue;}
        zip.file('عکس_'+(i+1)+'_'+w+'x'+h+'.'+ext, blob);
      }
      const zipBlob=await zip.generateAsync({type:'blob'});
      const a=document.createElement('a');a.href=URL.createObjectURL(zipBlob);a.download='عکس‌های_فشرده.zip';document.body.appendChild(a);a.click();a.remove();
      toast(failCount?('ZIP ساخته شد (برخی عکس‌ها با خطا مواجه شدند)'):'فایل ZIP دانلود شد ✅');
    }catch(e){
      toast('خطا در ساخت فایل ZIP');
    }finally{
      btn.disabled=false;btn.textContent=origText;
    }
  };

  document.getElementById('btn-clear-resize').onclick=()=>{RESIZE_IMAGES=[];renderResizePreview();document.getElementById('resize-controls').classList.add('hidden');};

  // ===== Crop (اصلاح‌شده با پشتیبانی از لمس برای گوشی) =====
  let cropImg = null,
    cropFileName = '',
    cropState = {
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      ratio: 'free',
      dragging: false,
      resizing: false,
      handle: '',
      startX: 0,
      startY: 0
    };

  const cropDropZone = document.getElementById('crop-drop-zone');
  const cropFileInput = document.getElementById('crop-file');
  const cropControls = document.getElementById('crop-controls');

  cropDropZone.addEventListener('click', () => cropFileInput.click());
  cropDropZone.addEventListener('dragover', e => { e.preventDefault();
    cropDropZone.style.borderColor = 'var(--primary)'; });
  cropDropZone.addEventListener('dragleave', () => { cropDropZone.style.borderColor = ''; });
  cropDropZone.addEventListener('drop', e => {
    e.preventDefault();
    cropDropZone.style.borderColor = '';
    if (e.dataTransfer.files[0]) loadCropImg(e.dataTransfer.files[0]);
  });
  cropFileInput.addEventListener('change', function() {
    if (this.files[0]) loadCropImg(this.files[0]);
  });

  function loadCropImg(file) {
    if (!file.type.startsWith('image/')) { toast('فقط عکس مجاز است'); return; }
    cropFileName = file.name;
    const rd = new FileReader();
    rd.onload = ev => {
      const img = document.getElementById('crop-img');
      img.onload = () => {
        // نمایش عکس با نسبت واقعی - محدودیت عرض و ارتفاع هر دو با هم در نظر گرفته می‌شوند
        // (قبلاً فقط عرض محدود می‌شد و CSS جداگانه ارتفاع را می‌بُرید، همین باعث کشیده‌شدن عکس می‌شد)
        const maxWidth = window.innerWidth - 80;
        const maxHeight = window.innerHeight * 0.5;
        let displayWidth = img.naturalWidth;
        let displayHeight = img.naturalHeight;
        const scale = Math.min(1, maxWidth / displayWidth, maxHeight / displayHeight);
        displayWidth = Math.round(displayWidth * scale);
        displayHeight = Math.round(displayHeight * scale);
        
        img.style.width = displayWidth + 'px';
        img.style.height = displayHeight + 'px';
        const wrapper = document.getElementById('crop-wrapper');
        wrapper.style.width = displayWidth + 'px';
        wrapper.style.height = displayHeight + 'px';
        cropImg = { el: img, natW: img.naturalWidth, natH: img.naturalHeight };
        initCropBox();
        cropControls.classList.remove('hidden');
        cropDropZone.classList.add('hidden');
      };
      img.onerror = () => { toast('فایل عکس معتبر نیست'); };
      img.src = ev.target.result;
    };
    rd.onerror = () => { toast('خطا در خواندن فایل'); };
    rd.readAsDataURL(file);
  }

  function initCropBox() {
    const img = document.getElementById('crop-img');
    const w = parseFloat(img.style.width);
    const h = parseFloat(img.style.height);
    const box = document.getElementById('crop-box');
    cropState.x = 0;
    cropState.y = 0;
    cropState.w = w;
    cropState.h = h;
    cropState.ratio = 'free';
    box.style.left = cropState.x + 'px';
    box.style.top = cropState.y + 'px';
    box.style.width = cropState.w + 'px';
    box.style.height = cropState.h + 'px';
    const ratioBtns = document.querySelectorAll('.ratio-btn');
    if (ratioBtns.length) {
      ratioBtns.forEach(b => b.classList.remove('active'));
      document.querySelector('.ratio-btn[data-ratio="free"]').classList.add('active');
    }
  }

  document.getElementById('btn-crop-delete').onclick = () => {
    cropImg = null;
    cropFileName = '';
    cropControls.classList.add('hidden');
    cropDropZone.classList.remove('hidden');
    document.getElementById('crop-img').src = '';
  };
  document.getElementById('btn-crop-reset').onclick = () => initCropBox();

  function applyRatio() {
    if (cropState.ratio === 'free') return;
    const wrapper = document.getElementById('crop-wrapper');
    const maxW = parseFloat(wrapper.style.width), maxH = parseFloat(wrapper.style.height);
    const parts = cropState.ratio.split(':').map(Number);
    const ratio = parts[0] / parts[1];
    // مرکز باکس فعلی را حفظ کن، فقط اندازه را با نسبت جدید تنظیم کن
    const cx = cropState.x + cropState.w / 2, cy = cropState.y + cropState.h / 2;
    let newW = cropState.w, newH = newW / ratio;
    if (newH > maxH) { newH = maxH; newW = newH * ratio; }
    if (newW > maxW) { newW = maxW; newH = newW / ratio; }
    cropState.w = newW; cropState.h = newH;
    cropState.x = Math.max(0, Math.min(maxW - newW, cx - newW / 2));
    cropState.y = Math.max(0, Math.min(maxH - newH, cy - newH / 2));
    updateCropBox();
  }

  document.querySelectorAll('.ratio-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.ratio-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      cropState.ratio = btn.dataset.ratio;
      applyRatio();
    };
  });

  function updateCropBox() {
    const box = document.getElementById('crop-box');
    box.style.left = cropState.x + 'px';
    box.style.top = cropState.y + 'px';
    box.style.width = cropState.w + 'px';
    box.style.height = cropState.h + 'px';
  }

  document.getElementById('btn-crop-download').onclick = () => {
    if (!cropImg) { toast('عکسی انتخاب نشده'); return; }
    const img = cropImg.el;
    const sx = cropState.x * (img.naturalWidth / parseFloat(img.style.width));
    const sy = cropState.y * (img.naturalHeight / parseFloat(img.style.height));
    const sw = cropState.w * (img.naturalWidth / parseFloat(img.style.width));
    const sh = cropState.h * (img.naturalHeight / parseFloat(img.style.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => {
      if (!blob) { toast('خطا در ساخت فایل عکس'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = cropFileName.replace(/\.[^.]+$/, '_cropped.png');
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('عکس برش‌خورده دانلود شد ✅');
    }, 'image/png', 1.0);
  };

  // ===== رویدادهای موس (برای کامپیوتر) =====
  const cropBox = document.getElementById('crop-box');

  function getCropPos(e) {
    const rect = cropBox.getBoundingClientRect();
    const wrapperRect = document.getElementById('crop-wrapper').getBoundingClientRect();
    return {
      clientX: e.clientX,
      clientY: e.clientY,
      offsetX: e.clientX - wrapperRect.left,
      offsetY: e.clientY - wrapperRect.top
    };
  }

  function startCropDrag(e) {
    e.preventDefault();
    const pos = getCropPos(e);
    
    if (e.target.classList.contains('crop-handle')) {
      cropState.resizing = true;
      cropState.handle = e.target.className.replace('crop-handle crop-', '');
    } else {
      cropState.dragging = true;
    }
    cropState.startX = pos.offsetX;
    cropState.startY = pos.offsetY;
  }

  // محاسبه‌ی تغییر اندازه با رعایت مرزهای تصویر (رفع اشکال قبلی: دسته‌های شمال/غرب می‌توانستند از تصویر بیرون بزنند)
  function resizeCropBox(rh, dx, dy, w, h) {
    if (rh.includes('e')) cropState.w = Math.max(50, Math.min(w - cropState.x, cropState.w + dx));
    if (rh.includes('w')) {
      let newX = Math.max(0, cropState.x + dx);
      let newW = cropState.w + (cropState.x - newX);
      if (newW < 50) { newW = 50; newX = cropState.x + cropState.w - 50; }
      cropState.x = newX; cropState.w = newW;
    }
    if (rh.includes('s')) cropState.h = Math.max(50, Math.min(h - cropState.y, cropState.h + dy));
    if (rh.includes('n')) {
      let newY = Math.max(0, cropState.y + dy);
      let newH = cropState.h + (cropState.y - newY);
      if (newH < 50) { newH = 50; newY = cropState.y + cropState.h - 50; }
      cropState.y = newY; cropState.h = newH;
    }
  }

  function moveCropDrag(e) {
    if (!cropState.dragging && !cropState.resizing) return;
    e.preventDefault();
    
    const pos = getCropPos(e);
    const dx = pos.offsetX - cropState.startX;
    const dy = pos.offsetY - cropState.startY;
    cropState.startX = pos.offsetX;
    cropState.startY = pos.offsetY;
    
    const wrapper = document.getElementById('crop-wrapper');
    const w = parseFloat(wrapper.style.width);
    const h = parseFloat(wrapper.style.height);
    
    if (cropState.dragging) {
      cropState.x = Math.max(0, Math.min(w - cropState.w, cropState.x + dx));
      cropState.y = Math.max(0, Math.min(h - cropState.h, cropState.y + dy));
    } else if (cropState.resizing) {
      resizeCropBox(cropState.handle, dx, dy, w, h);
    }
    updateCropBox();
  }

  function endCropDrag(e) {
    if (cropState.resizing && cropState.ratio !== 'free') applyRatio();
    cropState.dragging = false;
    cropState.resizing = false;
  }

  // رویدادهای موس (کامپیوتر)
  cropBox.addEventListener('mousedown', startCropDrag);
  document.addEventListener('mousemove', moveCropDrag);
  document.addEventListener('mouseup', endCropDrag);

  // ===== رویدادهای لمسی (گوشی) =====
  function getTouchPos(e) {
    const touch = e.touches[0];
    const rect = document.getElementById('crop-wrapper').getBoundingClientRect();
    return {
      clientX: touch.clientX,
      clientY: touch.clientY,
      offsetX: touch.clientX - rect.left,
      offsetY: touch.clientY - rect.top
    };
  }

  function startTouchDrag(e) {
    e.preventDefault();
    const pos = getTouchPos(e);
    
    // بررسی اینکه آیا روی دسته برش کلیک شده
    const touch = e.touches[0];
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    
    if (target && target.classList.contains('crop-handle')) {
      cropState.resizing = true;
      cropState.handle = target.className.replace('crop-handle crop-', '');
    } else {
      cropState.dragging = true;
    }
    cropState.startX = pos.offsetX;
    cropState.startY = pos.offsetY;
  }

  function moveTouchDrag(e) {
    if (!cropState.dragging && !cropState.resizing) return;
    e.preventDefault();
    
    const pos = getTouchPos(e);
    const dx = pos.offsetX - cropState.startX;
    const dy = pos.offsetY - cropState.startY;
    cropState.startX = pos.offsetX;
    cropState.startY = pos.offsetY;
    
    const wrapper = document.getElementById('crop-wrapper');
    const w = parseFloat(wrapper.style.width);
    const h = parseFloat(wrapper.style.height);
    
    if (cropState.dragging) {
      cropState.x = Math.max(0, Math.min(w - cropState.w, cropState.x + dx));
      cropState.y = Math.max(0, Math.min(h - cropState.h, cropState.y + dy));
    } else if (cropState.resizing) {
      resizeCropBox(cropState.handle, dx, dy, w, h);
    }
    updateCropBox();
  }

  function endTouchDrag(e) {
    if (cropState.resizing && cropState.ratio !== 'free') applyRatio();
    cropState.dragging = false;
    cropState.resizing = false;
  }

  // رویدادهای لمسی (گوشی) با passive: false برای جلوگیری از اسکرول
  cropBox.addEventListener('touchstart', startTouchDrag, { passive: false });
  document.addEventListener('touchmove', moveTouchDrag, { passive: false });
  document.addEventListener('touchend', endTouchDrag);

  // ===== PDF به عکس =====
  let pdfDoc=null,pdfFileName='',pdfRenderedPages=[];
  const pdfDropZone=document.getElementById('pdf-drop-zone');const pdfFileInput=document.getElementById('pdf-file');
  pdfDropZone.onclick=()=>pdfFileInput.click();
  pdfDropZone.addEventListener('dragover',e=>{e.preventDefault();pdfDropZone.style.borderColor='#667eea';});
  pdfDropZone.addEventListener('dragleave',()=>{pdfDropZone.style.borderColor='#ccc';});
  pdfDropZone.addEventListener('drop',e=>{e.preventDefault();pdfDropZone.style.borderColor='#ccc';if(e.dataTransfer.files[0])loadPdfFile(e.dataTransfer.files[0]);});
  pdfFileInput.addEventListener('change',e=>{if(e.target.files[0])loadPdfFile(e.target.files[0]);});

  async function loadPdfFile(file){if(file.type!=='application/pdf'){toast('فقط فایل PDF مجاز است');return;}pdfFileName=file.name;const arrayBuffer=await file.arrayBuffer();pdfDoc=await pdfjsLib.getDocument({data:arrayBuffer}).promise;document.getElementById('pdf-name').textContent=file.name;document.getElementById('pdf-pages-count').textContent=pdfDoc.numPages;document.getElementById('pdf-controls').classList.remove('hidden');document.getElementById('pdf-preview').innerHTML='';pdfRenderedPages=[];renderPdfPage(1);}

  async function renderPdfPage(pageNum){if(!pdfDoc)return;const page=await pdfDoc.getPage(pageNum);const dpi=parseInt(document.querySelector('.pdf-dpi-btn.active')?.dataset.dpi)||150;const scale=dpi/72;const viewport=page.getViewport({scale,rotation:pdfRotation});const canvas=document.createElement('canvas');canvas.width=viewport.width;canvas.height=viewport.height;const ctx=canvas.getContext('2d');await page.render({canvasContext:ctx,viewport}).promise;const format=document.querySelector('.pdf-format-btn.active')?.dataset.format||'png';const dataUrl=canvas.toDataURL('image/'+format,format==='jpeg'?parseInt(document.getElementById('jpeg-quality')?.value||85)/100:undefined);const previewDiv=document.getElementById('pdf-preview');const pageDiv=document.createElement('div');pageDiv.className='pdf-page-preview';pageDiv.style.cssText='display:inline-block;margin:8px;text-align:center;background:#fff;border:1px solid #ddd;border-radius:8px;padding:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1)';pageDiv.innerHTML='<div style="font-weight:bold;margin-bottom:8px">صفحه '+pageNum+'</div><img src="'+dataUrl+'" style="max-width:200px;max-height:280px;border:1px solid #eee"><div style="margin-top:8px"><button class="btn sm primary" onclick="downloadPdfPage('+pageNum+')">📥 دانلود</button></div>';previewDiv.appendChild(pageDiv);pdfRenderedPages.push({pageNum,canvas,dataUrl});return canvas;}
  window.downloadPdfPage=function(pageNum){const rp=pdfRenderedPages.find(p=>p.pageNum===pageNum);if(!rp){toast('صفحه رندر نشده');return;}const format=document.querySelector('.pdf-format-btn.active')?.dataset.format||'png';const ext=format==='jpeg'?'jpg':format;const a=document.createElement('a');a.href=rp.dataUrl;a.download=pdfFileName.replace('.pdf','_page_'+pageNum+'.'+ext);document.body.appendChild(a);a.click();a.remove();toast('صفحه '+pageNum+' دانلود شد ✅');};
  document.getElementById('pdf-remove').onclick=()=>{pdfDoc=null;pdfFileName='';pdfRenderedPages=[];pdfRotation=0;updatePdfRotateDisplay();document.getElementById('pdf-controls').classList.add('hidden');document.getElementById('pdf-preview').innerHTML='';};
  document.querySelectorAll('.pdf-select-btn').forEach(btn=>{btn.onclick=()=>{document.querySelectorAll('.pdf-select-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');const type=btn.dataset.pages;document.getElementById('pdf-range').classList.toggle('hidden',type!=='range');};});
  document.querySelectorAll('.pdf-dpi-btn').forEach(btn=>{btn.onclick=()=>{document.querySelectorAll('.pdf-dpi-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');};});
  let pdfRotation=0;
  function updatePdfRotateDisplay(){const fa=['۰','۹۰','۱۸۰','۲۷۰'][(pdfRotation/90+4)%4];document.getElementById('pdf-rotate-val').textContent=fa;}
  document.getElementById('btn-pdf-rotate-l').onclick=()=>{pdfRotation=(pdfRotation-90+360)%360;updatePdfRotateDisplay();toast('برای اعمال چرخش، دوباره «رندر همه صفحات» را بزنید');};
  document.getElementById('btn-pdf-rotate-r').onclick=()=>{pdfRotation=(pdfRotation+90)%360;updatePdfRotateDisplay();toast('برای اعمال چرخش، دوباره «رندر همه صفحات» را بزنید');};
  document.querySelectorAll('.pdf-format-btn').forEach(btn=>{btn.onclick=()=>{document.querySelectorAll('.pdf-format-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');const format=btn.dataset.format;document.getElementById('jpeg-quality-group').classList.toggle('hidden',format!=='jpeg');};});
  document.getElementById('jpeg-quality').oninput=function(){document.getElementById('jpeg-quality-val').textContent=this.value+'%';};
  
  document.getElementById('btn-pdf-render-all').onclick=async()=>{if(!pdfDoc){toast('فایل PDF انتخاب نشده');return;}document.getElementById('pdf-preview').innerHTML='';pdfRenderedPages=[];const selectType=document.querySelector('.pdf-select-btn.active')?.dataset.pages||'all';let pagesToRender=[];if(selectType==='all'){for(let i=1;i<=pdfDoc.numPages;i++)pagesToRender.push(i);}else if(selectType==='odd'){for(let i=1;i<=pdfDoc.numPages;i+=2)pagesToRender.push(i);}else if(selectType==='even'){for(let i=2;i<=pdfDoc.numPages;i+=2)pagesToRender.push(i);}else if(selectType==='range'){const rangeStr=document.getElementById('pdf-range').value;const parts=rangeStr.split(',');parts.forEach(p=>{if(p.includes('-')){const [s,e]=p.split('-').map(x=>parseInt(x.trim()));for(let i=s;i<=e;i++)if(i>=1&&i<=pdfDoc.numPages)pagesToRender.push(i);}else{const n=parseInt(p.trim());if(n>=1&&n<=pdfDoc.numPages)pagesToRender.push(n);}});}pagesToRender=[...new Set(pagesToRender)].sort((a,b)=>a-b);toast('در حال رندر '+pagesToRender.length+' صفحه...');for(const pn of pagesToRender){await renderPdfPage(pn);}toast('رندر تمام صفحات انجام شد ✅');};
  document.getElementById('btn-pdf-clear-previews').onclick=()=>{document.getElementById('pdf-preview').innerHTML='';pdfRenderedPages=[];};
  document.getElementById('btn-pdf-download-zip').onclick=async()=>{
    if(pdfRenderedPages.length===0){toast('ابتدا صفحات را رندر کنید');return;}
    if(!window.JSZip){toast('کتابخانه ZIP در دسترس نیست');return;}
    const btn=document.getElementById('btn-pdf-download-zip');btn.disabled=true;const origText=btn.textContent;btn.textContent='⏳ در حال ساخت ZIP...';
    try{
      const format=document.querySelector('.pdf-format-btn.active')?.dataset.format||'png';
      const ext=format==='jpeg'?'jpg':format;
      const mimeType='image/'+format;
      const zip=new JSZip();
      pdfRenderedPages.forEach(rp=>{
        const dataUrl=rp.canvas.toDataURL(mimeType,format==='jpeg'?parseInt(document.getElementById('jpeg-quality')?.value||85)/100:undefined);
        const base64=dataUrl.split(',')[1];
        zip.file(pdfFileName.replace(/\.pdf$/i,'')+'_page_'+rp.pageNum+'.'+ext, base64, {base64:true});
      });
      const blob=await zip.generateAsync({type:'blob'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=pdfFileName.replace(/\.pdf$/i,'')+'_pages.zip';document.body.appendChild(a);a.click();a.remove();
      toast('فایل ZIP شامل '+pdfRenderedPages.length+' صفحه دانلود شد ✅');
    }catch(e){
      toast('خطا در ساخت فایل ZIP');
    }finally{
      btn.disabled=false;btn.textContent=origText;
    }
  };

  // ===== PDF به Word (متن قابل ویرایش) =====
  let pdf2wordDoc=null,pdf2wordFileName='',pdf2wordBlob=null;
  const pdf2wordDropZone=document.getElementById('pdf2word-drop-zone');const pdf2wordFileInput=document.getElementById('pdf2word-file');
  pdf2wordDropZone.onclick=()=>pdf2wordFileInput.click();
  pdf2wordDropZone.addEventListener('dragover',e=>{e.preventDefault();pdf2wordDropZone.style.borderColor='#667eea';});
  pdf2wordDropZone.addEventListener('dragleave',()=>{pdf2wordDropZone.style.borderColor='#ccc';});
  pdf2wordDropZone.addEventListener('drop',e=>{e.preventDefault();pdf2wordDropZone.style.borderColor='#ccc';if(e.dataTransfer.files[0])loadPdf2WordFile(e.dataTransfer.files[0]);});
  pdf2wordFileInput.addEventListener('change',e=>{if(e.target.files[0])loadPdf2WordFile(e.target.files[0]);});

  async function loadPdf2WordFile(file){
    if(file.type!=='application/pdf'){toast('فقط فایل PDF مجاز است');return;}
    pdf2wordFileName=file.name;pdf2wordBlob=null;
    const arrayBuffer=await file.arrayBuffer();
    pdf2wordDoc=await pdfjsLib.getDocument({data:arrayBuffer}).promise;
    document.getElementById('pdf2word-name').textContent=file.name;
    document.getElementById('pdf2word-pages-count').textContent=pdf2wordDoc.numPages;
    document.getElementById('pdf2word-controls').classList.remove('hidden');
    document.getElementById('pdf2word-status').textContent='';
    document.getElementById('btn-pdf2word-download').classList.add('hidden');
  }

  document.getElementById('pdf2word-remove').onclick=()=>{
    pdf2wordDoc=null;pdf2wordFileName='';pdf2wordBlob=null;
    document.getElementById('pdf2word-controls').classList.add('hidden');
    document.getElementById('pdf2word-status').textContent='';
  };

  // استخراج متن هر صفحه بر اساس موقعیت واقعی روی صفحه + تشخیص خطوط واقعی جدول (رسم‌شده در PDF)
  // این روش دقیق‌تر از حدس‌زدن بر اساس فاصلهٔ متن‌هاست، چون از خود مرزهای جدول در فایل PDF استفاده می‌کند
  function pdf2wordCleanStr(s){return s.replace(/[\uE000-\uF8FF]/g,'');} // حذف کاراکترهای ناحیهٔ اختصاصی فونت (نامرئی/بی‌معنی)

  // ===== تشخیص و ترمیم PDFهایی با فونت فارسیِ خراب (نگاشت غلط ToUnicode) =====
  // برخی نرم‌افزارها (مثل سامانه‌های آموزشی قدیمی که فونت‌هایی مثل «Wyekan» را جاسازی می‌کنند) متن را طوری در PDF
  // ذخیره می‌کنند که ظاهر آن روی صفحه درست است، اما استخراج متن (کد کاراکترها) به‌هم‌ریخته و غیرقابل‌استفاده است،
  // چون این کاراکترها به بازه‌های یونیکد نامرتبط (Variation Selector, Combining Half Mark, Small Form Variant, ...)
  // نگاشت شده‌اند نه به حروف واقعی فارسی/عربی. برای این حالت، به‌جای تکیه بر متن استخراج‌شده، همان بخش از تصویر
  // صفحه با OCR (تشخیص نوری کاراکتر) خوانده می‌شود که همیشه درست است چون شکل ظاهری حروف سالم است.
  // به‌جای فهرست کردن بازه‌های «خراب» (که ممکن است ناقص باشد)، بازه‌های «سالمِ» مورد انتظار برای متن فارسی/عربی و
  // انگلیسی/اعداد را مشخص می‌کنیم؛ هر کاراکتری بیرون از این بازه‌ها تقریباً همیشه نشانهٔ نگاشت خراب فونت است
  const OK_RANGES=[[0x00,0x7F],[0x0600,0x06FF],[0x0750,0x077F],[0x08A0,0x08FF],[0xFB50,0xFDFF],[0xFE70,0xFEFF]];
  function hasBrokenGlyphs(str){
    for(let i=0;i<str.length;i++){
      const cp=str.codePointAt(i);
      if(cp>0xFFFF)i++; // کاراکترهای بیرون از BMP را رد کن (نادر و بی‌ربط به این مشکل)
      let ok=false;
      for(const[lo,hi]of OK_RANGES){if(cp>=lo&&cp<=hi){ok=true;break;}}
      if(!ok)return true;
    }
    return false;
  }
  let _ocrWorkerPromise=null;
  async function getOcrWorker(){
    if(!_ocrWorkerPromise){
      _ocrWorkerPromise=(async()=>{
        if(typeof Tesseract==='undefined')throw new Error('Tesseract not loaded');
        const worker=await Tesseract.createWorker('fas');
        // حالت پیش‌فرض Tesseract («تحلیل کامل صفحه») برای تکه‌های کوچک بریده‌شده (یک نام یا یک عدد) خوب کار نمی‌کند
        // و اغلب خروجی خالی می‌دهد؛ حالت «یک خط تکی» برای این کاربرد مناسب‌تر است
        await worker.setParameters({tessedit_pageseg_mode:'7'});
        return worker;
      })().catch(err=>{_ocrWorkerPromise=null;throw err;});
    }
    return _ocrWorkerPromise;
  }
  let ocrFixCount=0,ocrFailCount=0;
  // رندر کل صفحه با کیفیت بالا روی یک کنواس مخفی، فقط وقتی لازم باشد (یعنی متنِ خراب پیدا شده باشد)
  async function renderPageForOcr(page){
    const scale=4;
    const viewport=page.getViewport({scale});
    const canvas=document.createElement('canvas');
    canvas.width=Math.ceil(viewport.width);
    canvas.height=Math.ceil(viewport.height);
    const ctx=canvas.getContext('2d');
    await page.render({canvasContext:ctx,viewport}).promise;
    return{canvas,viewport};
  }
  // خواندن متن یک مستطیل مشخص از صفحه (در مختصات PDF) با OCR
  async function ocrRect(ocrCtx,xL,xR,yTop,yBot){
    if(!ocrCtx)return '';
    const{canvas,viewport}=ocrCtx;
    const p1=viewport.convertToViewportPoint(xL,yTop);
    const p2=viewport.convertToViewportPoint(xR,yBot);
    const pad=8;
    let x=Math.min(p1[0],p2[0])-pad,y=Math.min(p1[1],p2[1])-pad;
    let w=Math.abs(p2[0]-p1[0])+pad*2,h=Math.abs(p2[1]-p1[1])+pad*2;
    x=Math.max(0,x);y=Math.max(0,y);
    w=Math.min(canvas.width-x,w);h=Math.min(canvas.height-y,h);
    if(w<6||h<6)return '';
    const crop=document.createElement('canvas');
    crop.width=w;crop.height=h;
    crop.getContext('2d').drawImage(canvas,x,y,w,h,0,0,w,h);
    try{
      const worker=await getOcrWorker();
      let{data}=await worker.recognize(crop);
      let text=(data.text||'').replace(/\s+/g,' ').trim();
      if(!text){
        // اگر «یک خط» چیزی پیدا نکرد، شاید تکه فقط یک کلمهٔ تکی یا عدد کوتاه باشد
        await worker.setParameters({tessedit_pageseg_mode:'8'});
        ({data}=await worker.recognize(crop));
        text=(data.text||'').replace(/\s+/g,' ').trim();
        await worker.setParameters({tessedit_pageseg_mode:'7'});
      }
      if(text)ocrFixCount++;else ocrFailCount++;
      return text;
    }catch(err){ocrFailCount++;return '';}
  }
  // محدودهٔ x/y یک مجموعه آیتم متنی (برای برش تصویر جهت OCR)
  function itemsBBox(itemList){
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    itemList.forEach(it=>{
      const fontSize=Math.abs(it.transform[3])||Math.abs(it.transform[0])||10;
      const x0=it.transform[4],x1=it.transform[4]+(it.width||fontSize);
      const y0=it.transform[5]-fontSize*0.3,y1=it.transform[5]+fontSize*0.85;
      if(x0<minX)minX=x0;if(x1>maxX)maxX=x1;if(y0<minY)minY=y0;if(y1>maxY)maxY=y1;
    });
    return{xL:minX,xR:maxX,yBot:minY,yTop:maxY};
  }

  function pdf2wordClusterValues(vals,tol){
    const sorted=[...vals].sort((a,b)=>a-b);
    const clusters=[];
    sorted.forEach(v=>{
      if(clusters.length && v-clusters[clusters.length-1].vals[clusters[clusters.length-1].vals.length-1]<=tol){
        clusters[clusters.length-1].vals.push(v);
      }else{clusters.push({vals:[v]});}
    });
    return clusters.map(c=>c.vals.reduce((a,b)=>a+b,0)/c.vals.length);
  }

  // خطوط افقی/عمودی واقعی رسم‌شده در صفحه (مرزهای جدول) را با خواندن دستورهای گرافیکی PDF پیدا می‌کند
  async function pdf2wordExtractGridLines(page){
    const OPS=pdfjsLib.OPS;
    const opList=await page.getOperatorList();
    let curMatrix=[1,0,0,1,0,0];
    const matStack=[];
    const applyM=(m,p)=>[m[0]*p[0]+m[2]*p[1]+m[4], m[1]*p[0]+m[3]*p[1]+m[5]];
    const hLines=[],vLines=[];
    for(let i=0;i<opList.fnArray.length;i++){
      const fn=opList.fnArray[i],args=opList.argsArray[i];
      if(fn===OPS.save){matStack.push(curMatrix);}
      else if(fn===OPS.restore){curMatrix=matStack.pop()||curMatrix;}
      else if(fn===OPS.transform){
        const[a,b,c,d,e,f]=args,m=curMatrix;
        curMatrix=[a*m[0]+b*m[2],a*m[1]+b*m[3],c*m[0]+d*m[2],c*m[1]+d*m[3],e*m[0]+f*m[2]+m[4],e*m[1]+f*m[3]+m[5]];
      }else if(fn===OPS.constructPath){
        const[subOps,subArgs]=args;let ai=0,cx=0,cy=0,sx=0,sy=0;
        for(const op of subOps){
          if(op===OPS.moveTo){cx=subArgs[ai++];cy=subArgs[ai++];sx=cx;sy=cy;}
          else if(op===OPS.lineTo){
            const nx=subArgs[ai++],ny=subArgs[ai++];
            const p1=applyM(curMatrix,[cx,cy]),p2=applyM(curMatrix,[nx,ny]);
            const dx=Math.abs(p2[0]-p1[0]),dy=Math.abs(p2[1]-p1[1]);
            // آستانهٔ طول بزرگ‌تر: خطوط کوچک (دور چک‌باکس گزینه‌ها، خط‌چین جای خالی) نباید به‌عنوان مرز جدول در کل عرض صفحه در نظر گرفته شوند
            if(dy<0.5&&dx>28)hLines.push({x1:Math.min(p1[0],p2[0]),x2:Math.max(p1[0],p2[0]),y:(p1[1]+p2[1])/2});
            else if(dx<0.5&&dy>18)vLines.push({y1:Math.min(p1[1],p2[1]),y2:Math.max(p1[1],p2[1]),x:(p1[0]+p2[0])/2});
            cx=nx;cy=ny;
          }else if(op===OPS.curveTo){ai+=6;cx=subArgs[ai-2];cy=subArgs[ai-1];}
          else if(op===OPS.closePath){cx=sx;cy=sy;}
          else if(op===OPS.rectangle){
            const rx=subArgs[ai++],ry=subArgs[ai++],rw=subArgs[ai++],rh=subArgs[ai++];
            const p1=applyM(curMatrix,[rx,ry]),p2=applyM(curMatrix,[rx+rw,ry+rh]);
            const w=Math.abs(p2[0]-p1[0]),h=Math.abs(p2[1]-p1[1]);
            if(h<2&&w>28)hLines.push({x1:Math.min(p1[0],p2[0]),x2:Math.max(p1[0],p2[0]),y:(p1[1]+p2[1])/2});
            else if(w<2&&h>18)vLines.push({y1:Math.min(p1[1],p2[1]),y2:Math.max(p1[1],p2[1]),x:(p1[0]+p2[0])/2});
          }
        }
      }
    }
    return{hLines,vLines};
  }

  // تشخیص «شکاف بزرگ» بین دو تکهٔ متن مجاور = مرز واقعی دو بلوک/ستون جدا (نه فقط فاصلهٔ معمولی بین کلمات)
  // مثال کلاسیک: در سربرگ آزمون‌ها، «نام و نام‌خانوادگی:» (باکس راست) و عنوان وسط صفحه («مرکز ارزشیابی...»)
  // ممکن است روی یک خط افقی (همان y) قرار بگیرند چون کنار هم چیده شده‌اند، اما با فاصلهٔ خالی زیاد در وسط؛
  // بدون این تشخیص، این دو متنِ کاملاً نامرتبط به‌اشتباه به‌عنوان یک خط واحد به‌هم می‌چسبند.
  // محاسبهٔ شکاف با کسر عرض واقعی آیتم (it.width) دقیق‌تر از تفاضل سادهٔ x است و از تشخیص اشتباه در جمله‌های عادی جلوگیری می‌کند.
  const PDF2WORD_COL_BREAK_RATIO=4, PDF2WORD_COL_BREAK_MIN_ABS=18;
  function pdf2wordSplitIntoLines(sortedItems){
    const lines=[];let cur=[];let prevItem=null;
    sortedItems.forEach(it=>{
      if(prevItem){
        const prevRight=prevItem.transform[4];
        const curRight=it.transform[4]+(it.width||0);
        const gap=prevRight-curRight;
        const fontSize=Math.abs(it.transform[3])||Math.abs(it.transform[0])||10;
        if(gap>Math.max(fontSize*PDF2WORD_COL_BREAK_RATIO,PDF2WORD_COL_BREAK_MIN_ABS)){lines.push(cur);cur=[];}
      }
      cur.push(it);prevItem=it;
    });
    if(cur.length)lines.push(cur);
    return lines;
  }

  // اتصال هوشمند تکه‌های متن: فقط وقتی فاصلهٔ واقعی بین دو تکه به‌اندازهٔ کافی بزرگ باشد یک space درج می‌شود
  // (وگرنه دو تکه بخشی از یک کلمهٔ واحدند و نباید فاصله بینشان بیفتد — مثل «دبستا»+«ن» که باید «دبستان» شود)
  function pdf2wordJoinItems(sortedItems){
    let text='';
    let prevItem=null;
    sortedItems.forEach(it=>{
      if(prevItem){
        const gap=prevItem.transform[4]-it.transform[4];
        const fontSize=Math.abs(it.transform[3])||Math.abs(it.transform[0])||10;
        if(gap/fontSize>0.7 && !text.endsWith(' '))text+=' ';
      }
      text+=it.str;
      prevItem=it;
    });
    return text;
  }

  // متن یک بلوک از آیتم‌ها را با فاصله‌گذاری درست و حفظ خط‌های داخلی می‌سازد
  // ocrCtx در صورت وجود، برای ترمیم خط‌هایی با کاراکترهای خراب (فونت غیراستاندارد) استفاده می‌شود
  async function pdf2wordBuildCellText(cellItems,ocrCtx){
    const microLines=[];
    cellItems.forEach(it=>{
      const y=it.transform[5];
      let ml=microLines.find(m=>Math.abs(m.y-y)<=3);
      if(!ml){ml={y,items:[]};microLines.push(ml);}
      ml.items.push(it);
    });
    microLines.sort((a,b)=>b.y-a.y);
    const out=[];
    for(const ml of microLines){
      const sorted=[...ml.items].sort((a,b)=>b.transform[4]-a.transform[4]);
      const subLines=pdf2wordSplitIntoLines(sorted); // جلوگیری از چسبیدن متن ستون‌های مجزای هم‌ارتفاع به هم
      for(const sub of subLines){
        let text=pdf2wordJoinItems(sub).replace(/\s+/g,' ').replace(/\s+([.,،؛:؟!])/g,'$1').trim();
        if(text!==''&&ocrCtx&&hasBrokenGlyphs(text)){
          const bb=itemsBBox(sub);
          const ocrText=await ocrRect(ocrCtx,bb.xL,bb.xR,bb.yTop,bb.yBot);
          if(ocrText)text=ocrText;
        }
        if(text!=='')out.push(text);
      }
    }
    return out;
  }

  // خروجی هر صفحه: آرایه‌ای از بلوک‌ها — {type:'table', rows:[[متن سلول‌ها به ترتیب راست‌به‌چپ],...]} یا {type:'para', lines:[...]}
  async function extractPdfPageBlocks(pageNum,docOverride){
    const doc=docOverride||pdf2wordDoc;
    const page=await doc.getPage(pageNum);
    const content=await page.getTextContent();
    const items=content.items.filter(it=>it.str!==undefined).map(it=>({...it,str:pdf2wordCleanStr(it.str)})).filter(it=>it.str.trim()!=='');
    if(items.length===0)return[];

    // اگر PDF از فونتی با نگاشت خراب استفاده کند، صفحه یک‌بار برای استفادهٔ بعدی در OCR رندر می‌شود
    let ocrCtx=null;
    if(items.some(it=>hasBrokenGlyphs(it.str))){
      try{ocrCtx=await renderPageForOcr(page);}catch(err){ocrCtx=null;}
    }

    const{hLines,vLines}=await pdf2wordExtractGridLines(page);

    // بدون خط جدول: همهٔ متن به‌صورت پاراگراف معمولی (بر اساس ردیف Y + راست‌به‌چپ)
    const buildPlainParas=async(itemList)=>{
      const lines=[];
      itemList.forEach(it=>{
        const y=it.transform[5];
        const fontSize=Math.abs(it.transform[3])||Math.abs(it.transform[0])||10;
        const tol=Math.max(2,fontSize*0.35);
        let line=lines.find(l=>Math.abs(l.y-y)<=tol);
        if(!line){line={y,items:[]};lines.push(line);}
        line.items.push(it);
      });
      lines.sort((a,b)=>b.y-a.y);
      const out=[];
      for(const l of lines){
        const sorted=[...l.items].sort((a,b)=>b.transform[4]-a.transform[4]);
        const subLines=pdf2wordSplitIntoLines(sorted); // جلوگیری از چسبیدن متن ستون‌های مجزای هم‌ارتفاع به هم (مثلاً باکس‌های سربرگ آزمون)
        for(const sub of subLines){
          let text=pdf2wordJoinItems(sub).replace(/\s+/g,' ').replace(/\s+([.,،؛:؟!])/g,'$1').trim();
          if(text!==''&&ocrCtx&&hasBrokenGlyphs(text)){
            const bb=itemsBBox(sub);
            const ocrText=await ocrRect(ocrCtx,bb.xL,bb.xR,bb.yTop,bb.yBot);
            if(ocrText)text=ocrText;
          }
          if(text!=='')out.push({type:'para',text});
        }
      }
      return out;
    };

    if(hLines.length<2)return await buildPlainParas(items);

    const rowBounds=pdf2wordClusterValues(hLines.map(l=>l.y),2).sort((a,b)=>b-a);
    const yTopMost=rowBounds[0],yBotMost=rowBounds[rowBounds.length-1];
    const blocks=[];

    // متن‌های بالاتر از جدول (پاراگراف)
    const aboveItems=items.filter(it=>it.transform[5]>yTopMost+1);
    blocks.push(...(await buildPlainParas(aboveItems)));

    const tableRows=[];
    for(let r=0;r<rowBounds.length-1;r++){
      const yTop=rowBounds[r],yBot=rowBounds[r+1];
      const bandVX=vLines.filter(v=>v.y1<=yTop-1&&v.y2>=yBot+1).map(v=>v.x);
      let colBounds=pdf2wordClusterValues(bandVX,2).sort((a,b)=>a-b);
      const bandItems=items.filter(it=>{const y=it.transform[5];return y<=yTop+1&&y>=yBot-1;});
      if(colBounds.length<2){
        if(bandItems.length===0)continue;
        tableRows.push([await pdf2wordBuildCellText(bandItems,ocrCtx)]);
        continue;
      }
      const cols=[];
      for(let c=colBounds.length-2;c>=0;c--){
        const xL=colBounds[c],xR=colBounds[c+1];
        const cellItems=bandItems.filter(it=>{const x=it.transform[4];return x>=xL-1&&x<=xR+1;});
        cols.push(await pdf2wordBuildCellText(cellItems,ocrCtx));
      }
      tableRows.push(cols);
    }
    if(tableRows.length>0)blocks.push({type:'table',rows:tableRows});

    // متن‌های پایین‌تر از جدول (پاراگراف)
    const belowItems=items.filter(it=>it.transform[5]<yBotMost-1);
    blocks.push(...(await buildPlainParas(belowItems)));

    return blocks;
  }

  function escapeHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

  document.getElementById('btn-pdf2word-convert').onclick=async()=>{
    if(!pdf2wordDoc){toast('فایل PDF انتخاب نشده');return;}
    const btn=document.getElementById('btn-pdf2word-convert');btn.disabled=true;const origText=btn.textContent;
    const statusEl=document.getElementById('pdf2word-status');
    ocrFixCount=0;ocrFailCount=0;
    try{
      let bodyHtml='';
      for(let i=1;i<=pdf2wordDoc.numPages;i++){
        statusEl.textContent='در حال استخراج متن صفحه '+i+' از '+pdf2wordDoc.numPages+'...';
        btn.textContent='⏳ '+i+'/'+pdf2wordDoc.numPages;
        const blocks=await extractPdfPageBlocks(i);
        const pageBreak=i>1?'style="page-break-before:always"':'';
        bodyHtml+='<div '+pageBreak+'>';
        if(blocks.length===0){
          bodyHtml+='<p style="color:#999">[این صفحه متن قابل استخراج ندارد — احتمالاً عکس یا اسکن است]</p>';
        }else{
          blocks.forEach(block=>{
            if(block.type==='table'){
              const maxCols=Math.max(...block.rows.map(r=>r.length));
              bodyHtml+='<table style="width:100%;border-collapse:collapse;table-layout:fixed" dir="rtl"><tbody>';
              block.rows.forEach(cells=>{
                bodyHtml+='<tr>';
                cells.forEach((cellLines,idx)=>{
                  // فقط سلول اول (راست‌ترین) در ردیف‌های چندستونی ممکن است ستون «شماره» باشد — بقیهٔ سلول‌های کوتاه نباید باریک/وسط‌چین شوند
                  const isNarrow=idx===0&&cells.length>1&&maxCols>2&&cellLines.length===1&&cellLines[0].length<=3;
                  const isLast=idx===cells.length-1;
                  const colspan=isLast&&cells.length<maxCols?' colspan="'+(maxCols-cells.length+1)+'"':'';
                  const cellHtml=cellLines.length>0?cellLines.map(l=>escapeHtml(l)).join('<br>'):'&nbsp;';
                  bodyHtml+='<td'+colspan+' style="border:1px solid #333;padding:5px 8px;vertical-align:top;'+(isNarrow?'width:36px;text-align:center':'')+'">'+cellHtml+'</td>';
                });
                bodyHtml+='</tr>';
              });
              bodyHtml+='</tbody></table>';
            }else{
              bodyHtml+='<p style="margin:0 0 6px 0">'+(block.text?escapeHtml(block.text):'&nbsp;')+'</p>';
            }
          });
        }
        bodyHtml+='</div>';
      }
      const htmlDoc='<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">'+
        '<head><meta charset="utf-8"><title>'+escapeHtml(pdf2wordFileName)+'</title>'+
        '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->'+
        '<style>@page{size:21cm 29.7cm;margin:2cm}body{font-family:"B Nazanin","Vazirmatn","Tahoma",sans-serif;font-size:14pt;direction:rtl;text-align:right}p{margin:0 0 6px 0}table{margin:0 0 6px 0}</style>'+
        '</head><body dir="rtl">'+bodyHtml+'</body></html>';
      pdf2wordBlob=new Blob(['\ufeff'+htmlDoc],{type:'application/msword'});
      let doneMsg='✅ تبدیل انجام شد — '+pdf2wordDoc.numPages+' صفحه استخراج شد.';
      if(ocrFixCount>0)doneMsg+=' ('+ocrFixCount+' بخش با فونت خراب توسط OCR ترمیم شد'+(ocrFailCount>0?'، '+ocrFailCount+' مورد نیاز به بازبینی دستی دارد':'')+')';
      statusEl.textContent=doneMsg;
      document.getElementById('btn-pdf2word-download').classList.remove('hidden');
      toast('فایل Word آماده شد ✅');
    }catch(e){
      statusEl.textContent='';
      toast('خطا در تبدیل PDF به Word');
    }finally{
      btn.disabled=false;btn.textContent=origText;
    }
  };

  document.getElementById('btn-pdf2word-download').onclick=()=>{
    if(!pdf2wordBlob){toast('ابتدا تبدیل را انجام دهید');return;}
    const a=document.createElement('a');
    a.href=URL.createObjectURL(pdf2wordBlob);
    a.download=pdf2wordFileName.replace(/\.pdf$/i,'')+'.doc';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('فایل Word دانلود شد ✅');
  };

  // ===== ترجمه =====
  document.getElementById('tl-from').onchange=function(){const f=this.value;const t=document.getElementById('tl-to');if(f===t.value){t.value=f==='fa'?'en':'fa';}};
  const tlLangNames={auto:'زبان ورودی (تشخیص خودکار)',fa:'فارسی',en:'انگلیسی',ar:'عربی',fr:'فرانسوی',de:'آلمانی',tr:'ترکی استانبولی',es:'اسپانیایی',it:'ایتالیایی',pt:'پرتغالی',ru:'روسی',zh:'چینی',ja:'ژاپنی',ko:'کره‌ای',ur:'اردو',hi:'هندی',ps:'پشتو',ku:'کردی سورانی',az:'آذربایجانی',hy:'ارمنی'};
  const tlLangDir={fa:'rtl',ar:'rtl',ur:'rtl',ps:'rtl',ku:'rtl',en:'ltr',fr:'ltr',de:'ltr',tr:'ltr',es:'ltr',it:'ltr',pt:'ltr',ru:'ltr',zh:'ltr',ja:'ltr',ko:'ltr',hi:'ltr',az:'ltr',hy:'ltr'};
  const tlToneNames={neutral:'',formal:'Use a formal / official tone suitable for administrative and formal correspondence.',informal:'Use a casual, everyday conversational tone.',academic:'Use a formal academic/scientific tone suitable for educational and research texts.',simple:'Use very simple, easy words suitable for children or beginners.'};
  function tlUpdateDirs(){
    const fromVal=document.getElementById('tl-from').value;
    document.getElementById('tl-input').dir=fromVal==='auto'?'auto':(tlLangDir[fromVal]||'rtl');
    document.getElementById('tl-output').dir=tlLangDir[document.getElementById('tl-to').value]||'ltr';
  }
  function tlUpdateCounts(){
    const inLen=document.getElementById('tl-input').value.length;
    const outLen=document.getElementById('tl-output').value.length;
    document.getElementById('tl-input-count').textContent=inLen.toLocaleString('fa-IR')+' کاراکتر';
    document.getElementById('tl-output-count').textContent=outLen.toLocaleString('fa-IR')+' کاراکتر';
  }
  document.getElementById('tl-from').addEventListener('change',tlUpdateDirs);
  document.getElementById('tl-to').addEventListener('change',tlUpdateDirs);
  document.getElementById('tl-input').addEventListener('input',tlUpdateCounts);
  window.tlSwap=function(){
    const f=document.getElementById('tl-from');const t=document.getElementById('tl-to');
    if(f.value==='auto'){toast('برای جابه‌جایی، ابتدا یک زبان مبدأ مشخص انتخاب کنید (نه تشخیص خودکار)');return;}
    const tmp=f.value;f.value=t.value;t.value=tmp;
    const inp=document.getElementById('tl-input');const out=document.getElementById('tl-output');
    const t2=inp.value;inp.value=out.value;out.value=t2;
    tlUpdateDirs();tlUpdateCounts();
    document.getElementById('tl-back-box').classList.add('hidden');
  };
  window.tlCopy=function(){const txt=document.getElementById('tl-output').value;if(!txt){toast('متنی وارد نشده');return;}navigator.clipboard.writeText(txt).then(()=>toast('کپی شد ✅'));};
  window.tlClear=function(){document.getElementById('tl-input').value='';document.getElementById('tl-output').value='';tlUpdateCounts();document.getElementById('tl-back-box').classList.add('hidden');};
  async function tlCallAi(text,fromName,toName,toneInstruction,autoDetect){
    const sys='You are a professional, experienced human translator. Translate the text the user sends '+
      (autoDetect?'(automatically detect the source language) ':'from '+fromName+' ')+
      'into '+toName+'. '+(toneInstruction||'')+' '+
      'Preserve the original meaning, paragraph breaks, and any numbers/names exactly. '+
      'Respond with ONLY the translation itself — natural, fluent, and idiomatic — no quotes, no explanations, no extra commentary, no original text repeated.';
    const res=await fetch('/api/teacher/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'system',content:sys},{role:'user',content:text}],max_tokens:4096,provider:getAiProvider()})});
    const data=await res.json();
    if(data.error)throw new Error(data.error);
    return (data.content||'').trim();
  }
  document.getElementById('btn-translate').onclick=async function(){
    const text=document.getElementById('tl-input').value.trim();
    if(!text){toast('متنی وارد نشده');return;}
    const from=document.getElementById('tl-from').value, to=document.getElementById('tl-to').value;
    if(from===to){toast('زبان مبدا و مقصد یکسان است');return;}
    const tone=document.getElementById('tl-tone').value;
    const btn=this;btn.disabled=true;btn.textContent='⏳ در حال ترجمه...';
    document.getElementById('tl-back-box').classList.add('hidden');
    try{
      const out=await tlCallAi(text,tlLangNames[from],tlLangNames[to],tlToneNames[tone],from==='auto');
      document.getElementById('tl-output').value=out;
      tlUpdateDirs();tlUpdateCounts();
      toast('ترجمه شد ✅');
    }catch(e){toast('خطا در ترجمه: '+e.message);}
    btn.disabled=false;btn.textContent='🌐 ترجمه کن';
  };
  document.getElementById('btn-translate-back').onclick=async function(){
    const out=document.getElementById('tl-output').value.trim();
    if(!out){toast('ابتدا متن را ترجمه کنید');return;}
    const from=document.getElementById('tl-from').value, to=document.getElementById('tl-to').value;
    const targetLangForBack=from==='auto'?'fa':from; // اگر مبدا «تشخیص خودکار» بود، بازترجمه را به فارسی نشان می‌دهیم
    const btn=this;btn.disabled=true;btn.textContent='⏳ در حال بازبینی...';
    try{
      const backText=await tlCallAi(out,tlLangNames[to],tlLangNames[targetLangForBack],'',false);
      document.getElementById('tl-back-text').textContent=backText;
      document.getElementById('tl-back-text').dir=tlLangDir[targetLangForBack]||'rtl';
      document.getElementById('tl-back-box').classList.remove('hidden');
    }catch(e){toast('خطا در بازبینی: '+e.message);}
    btn.disabled=false;btn.textContent='🔁 بازبینی (ترجمه معکوس)';
  };
  document.getElementById('tl-input').addEventListener('keydown',function(e){
    if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();document.getElementById('btn-translate').click();}
  });
  tlUpdateDirs();tlUpdateCounts();

  // ===== گرفتن متن ورودی ترجمه از عکس (OCR با هوش مصنوعی تصویری) یا از فایل PDF =====
  const tlExtractStatus=document.getElementById('tl-extract-status');
  document.getElementById('btn-tl-from-img').onclick=()=>{document.getElementById('tl-img-file').click();};
  document.getElementById('tl-img-file').addEventListener('change',async function(e){
    const file=e.target.files[0];
    if(!file)return;
    if(!file.type.startsWith('image/')){toast('لطفاً یک فایل تصویری انتخاب کنید');e.target.value='';return;}
    const btn=document.getElementById('btn-tl-from-img');btn.disabled=true;
    tlExtractStatus.textContent='⏳ در حال خواندن متن از عکس...';
    try{
      const dataUrl=await new Promise((resolve,reject)=>{
        const reader=new FileReader();
        reader.onload=()=>resolve(reader.result);
        reader.onerror=reject;
        reader.readAsDataURL(file);
      });
      const sys='You are an OCR engine. Extract ALL text visible in the image EXACTLY as written, preserving line breaks and paragraph structure. Do NOT translate it. Do NOT add any commentary, headers, or explanation — output ONLY the extracted text, nothing else.';
      const res=await fetch('/api/teacher/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'system',content:sys},{role:'user',content:[{type:'text',text:'متن این تصویر را استخراج کن.'},{type:'image_url',image_url:{url:dataUrl}}]}],max_tokens:4096,provider:getAiProvider()})});
      const data=await res.json();
      if(data.error)throw new Error(data.error);
      const extracted=(data.content||'').trim();
      if(!extracted){toast('متنی در عکس پیدا نشد');}
      else{
        document.getElementById('tl-input').value=extracted;
        tlUpdateDirs();tlUpdateCounts();
        toast('متن از عکس استخراج شد ✅ — حالا زبان و لحن را بررسی و ترجمه کنید');
      }
    }catch(err){toast('خطا در خواندن عکس: '+err.message);}
    tlExtractStatus.textContent='';
    btn.disabled=false;
    e.target.value='';
  });

  document.getElementById('btn-tl-from-pdf').onclick=()=>{document.getElementById('tl-pdf-file').click();};
  document.getElementById('tl-pdf-file').addEventListener('change',async function(e){
    const file=e.target.files[0];
    if(!file)return;
    const btn=document.getElementById('btn-tl-from-pdf');btn.disabled=true;
    tlExtractStatus.textContent='در حال خواندن فایل PDF...';
    try{
      const buf=await file.arrayBuffer();
      const doc=await pdfjsLib.getDocument({data:buf}).promise;
      const parts=[];
      for(let p=1;p<=doc.numPages;p++){
        tlExtractStatus.textContent='در حال استخراج متن صفحه '+p+' از '+doc.numPages+'...';
        const blocks=await extractPdfPageBlocks(p,doc);
        blocks.forEach(b=>{
          if(b.type==='table'){
            b.rows.forEach(cells=>{parts.push(cells.map(cellLines=>cellLines.join(' ')).join(' | '));});
          }else if(b.type==='para'&&b.text){
            parts.push(b.text);
          }
        });
      }
      const extracted=parts.join('\\n').trim();
      if(!extracted){toast('متنی در این PDF پیدا نشد (شاید فقط عکس/اسکن باشد)');}
      else{
        document.getElementById('tl-input').value=extracted;
        tlUpdateDirs();tlUpdateCounts();
        toast('متن از PDF استخراج شد ✅ ('+doc.numPages+' صفحه) — حالا زبان و لحن را بررسی و ترجمه کنید');
      }
    }catch(err){toast('خطا در خواندن فایل PDF: '+err.message);}
    tlExtractStatus.textContent='';
    btn.disabled=false;
    e.target.value='';
  });

  // ===== AI Chat =====
  let aiMessages=[{role:'system',content:'تو یک دستیار هوشمند برای معلمان هستی. به زبان فارسی پاسخ بده.'}];
  let aiPendingImage=null; // dataURL تصویر ضمیمه‌شده (در صورت وجود) پیش از ارسال پیام بعدی
  const aiInput=document.getElementById('ai-input');
  aiInput.addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px';});
  document.getElementById('btn-ai-img-pick').onclick=()=>{document.getElementById('ai-img-file').click();};
  document.getElementById('ai-img-file').addEventListener('change',function(e){
    const file=e.target.files[0];
    if(!file)return;
    if(!file.type.startsWith('image/')){toast('لطفاً یک فایل تصویری انتخاب کنید');e.target.value='';return;}
    const reader=new FileReader();
    reader.onload=function(){
      aiPendingImage=reader.result;
      document.getElementById('ai-img-preview-thumb').src=aiPendingImage;
      document.getElementById('ai-img-preview').classList.remove('hidden');
    };
    reader.readAsDataURL(file);
    e.target.value='';
  });
  document.getElementById('btn-ai-img-remove').onclick=()=>{
    aiPendingImage=null;
    document.getElementById('ai-img-preview').classList.add('hidden');
  };
  let aiPendingPdfText=null,aiPendingPdfName='';
  document.getElementById('btn-ai-pdf-pick').onclick=()=>{document.getElementById('ai-pdf-file').click();};
  document.getElementById('ai-pdf-file').addEventListener('change',async function(e){
    const file=e.target.files[0];
    if(!file)return;
    if(file.type!=='application/pdf'){toast('لطفاً یک فایل PDF انتخاب کنید');e.target.value='';return;}
    const btn=document.getElementById('btn-ai-pdf-pick');btn.disabled=true;
    toast('در حال استخراج متن از PDF...');
    try{
      const buf=await file.arrayBuffer();
      const doc=await pdfjsLib.getDocument({data:buf}).promise;
      const parts=[];
      for(let p=1;p<=doc.numPages;p++){
        const blocks=await extractPdfPageBlocks(p,doc);
        blocks.forEach(function(b){
          if(b.type==='table'){b.rows.forEach(function(cells){parts.push(cells.map(function(cellLines){return cellLines.join(' ');}).join(' | '));});}
          else if(b.type==='para'&&b.text){parts.push(b.text);}
        });
      }
      const extracted=parts.join('\\n').trim();
      if(!extracted){toast('متنی در این PDF پیدا نشد (شاید فقط عکس/اسکن باشد)');e.target.value='';btn.disabled=false;return;}
      aiPendingPdfText=extracted;
      aiPendingPdfName=file.name;
      document.getElementById('ai-pdf-preview-name').textContent='📄 '+file.name+' ('+doc.numPages+' صفحه)';
      document.getElementById('ai-pdf-preview').classList.remove('hidden');
      toast('متن PDF استخراج شد ✅');
    }catch(err){toast('خطا در خواندن PDF: '+err.message);}
    btn.disabled=false;
    e.target.value='';
  });
  document.getElementById('btn-ai-pdf-remove').onclick=()=>{
    aiPendingPdfText=null;aiPendingPdfName='';
    document.getElementById('ai-pdf-preview').classList.add('hidden');
  };
  function addAiMessage(role,text,imageUrl,msgId){
    const box=document.getElementById('ai-messages');
    const isUser=role==='user';
    const imgHtml=imageUrl?'<img src="'+imageUrl+'" style="max-width:180px;max-height:180px;border-radius:8px;display:block;margin-bottom:6px">':'';
    const id=msgId||('aimsg_'+Date.now()+'_'+Math.floor(Math.random()*10000));
    const html='<div class="ai-message '+(isUser?'user':'ai')+'" data-msgid="'+id+'"><div class="ai-message-avatar">'+(isUser?'👤':'🤖')+'</div><div class="ai-message-content"><div class="ai-message-text" id="'+id+'">'+imgHtml+esc(text)+'</div><button type="button" class="ai-copy-btn" onclick="copyAiMsg(\\''+id+'\\',this)">📋 کپی</button><button type="button" class="ai-del-btn" onclick="deleteAiMsg(\\''+id+'\\')">🗑️ حذف</button></div></div>';
    box.insertAdjacentHTML('beforeend',html);
    box.scrollTop=box.scrollHeight;
    return id;
  }
  window.copyAiMsg=function(msgId,btn){
    const el=document.getElementById(msgId);
    if(!el)return;
    const text=el.innerText||el.textContent||'';
    navigator.clipboard.writeText(text).then(()=>{
      const old=btn.innerHTML;
      btn.innerHTML='✅ کپی شد';
      setTimeout(()=>{btn.innerHTML=old;},1500);
    }).catch(()=>{toast('کپی ناموفق بود');});
  };
  window.deleteAiMsg=function(msgId){
    const bubble=document.querySelector('.ai-message[data-msgid="'+msgId+'"]');
    if(bubble)bubble.remove();
    aiMessages=aiMessages.filter(m=>m._id!==msgId);
    toast('پیام حذف شد');
  };
  document.getElementById('btn-ai-clear').onclick=()=>{
    if(!confirm('آیا از پاک کردن کل گفتگو مطمئن هستید؟ این کار قابل بازگشت نیست.'))return;
    document.getElementById('ai-messages').innerHTML='<div class="ai-message ai"><div class="ai-message-avatar">🤖</div><div class="ai-message-content"><div class="ai-message-text">سلام! 👋 من دستیار هوش مصنوعی شما هستم. چطور می‌توانم کمکتان کنم؟</div></div></div>';
    aiMessages=[{role:'system',content:'تو یک دستیار هوشمند برای معلمان هستی. به زبان فارسی پاسخ بده.'}];
    toast('گفتگو پاک شد');
  };
  function showTyping(){document.getElementById('ai-typing').classList.remove('hidden');document.getElementById('ai-messages').scrollTop=document.getElementById('ai-messages').scrollHeight;}
  function hideTyping(){document.getElementById('ai-typing').classList.add('hidden');}
  document.getElementById('btn-ai-send').onclick=async()=>{
    const text=aiInput.value.trim();
    const img=aiPendingImage;
    const pdfText=aiPendingPdfText;
    const pdfName=aiPendingPdfName;
    if(!text&&!img&&!pdfText)return;
    aiInput.value='';aiInput.style.height='auto';
    const displayText=(text||(pdfText?'':'(بدون متن)'))+(pdfText?'\\n\\n📄 فایل ضمیمه: '+pdfName:'');
    const userMsgId=addAiMessage('user',displayText,img);
    let apiText=text;
    if(pdfText){
      apiText=(text?text+'\\n\\n':'')+'متن استخراج‌شده از فایل PDF («'+pdfName+'»):\\n---\\n'+pdfText+'\\n---';
    }
    if(img){
      aiMessages.push({role:'user',content:[{type:'text',text:apiText||'این تصویر را توضیح بده'},{type:'image_url',image_url:{url:img}}],_id:userMsgId});
    }else{
      aiMessages.push({role:'user',content:apiText||'لطفاً این متن را بررسی کن.',_id:userMsgId});
    }
    aiPendingImage=null;
    aiPendingPdfText=null;aiPendingPdfName='';
    document.getElementById('ai-img-preview').classList.add('hidden');
    document.getElementById('ai-pdf-preview').classList.add('hidden');
    showTyping();
    try{
      const msgs=aiMessages.slice(-10).map(m=>({role:m.role,content:m.content}));
      const res=await fetch('/api/teacher/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:msgs,provider:getAiProvider(),max_tokens:4096})});
      const d=await res.json();
      hideTyping();
      if(d.error){addAiMessage('ai','❌ خطا: '+d.error);return;}
      const aiMsgId=addAiMessage('ai',d.content);
      aiMessages.push({role:'assistant',content:d.content,_id:aiMsgId});
    }catch(e){
      hideTyping();
      addAiMessage('ai','❌ خطا در اتصال: '+e.message);
    }
  };
  aiInput.onkeydown=e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.getElementById('btn-ai-send').click();} };

  // ===== تغییر رمز عبور =====
  document.getElementById('btn-change-pass').onclick=async()=>{
    const np=document.getElementById('new-pass').value;
    const msg=document.getElementById('pass-msg');
    const d=await api('/api/teacher/password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({newPassword:np})});
    if(d.ok){msg.style.color='#166534';msg.textContent='رمز عبور با موفقیت تغییر کرد.';document.getElementById('new-pass').value='';}
    else{msg.style.color='var(--danger)';msg.textContent=d.error||'خطا';}
  };

  // ===== کلاس آنلاین (تخته هوشمند + چت + صدای زنده معلم) =====
  async function renderClassLinks(){
    const d=await api('/api/teacher/students');
    const box=document.getElementById('cls-links-list');
    if(!d.students.length){box.innerHTML='<p class="muted">ابتدا از تب «دانش‌آموزان» برای هر نفر یک لینک بسازید.</p>';return;}
    box.innerHTML='<table><tr><th>#</th><th>نام</th><th>لینک ورود به کلاس آنلاین</th><th></th></tr>'+
      d.students.map((s,i)=>{
        const link=location.origin+'/class/'+s.uuid;
        return '<tr><td>'+(i+1)+'</td><td>'+esc(s.label||'-')+'</td>'+
          '<td><div class="link-box">'+link+'</div></td>'+
          '<td><button class="btn sm" onclick="copyLink(\\''+link+'\\')">کپی</button></td></tr>';
      }).join('')+'</table>';
  }

  let clsWs=null, clsMicStream=null, clsRecorder=null, clsDrawing=false, clsLastPoint=null, clsCurrentStroke=null, clsAudioActive=false, clsAudioGen=0;
  let clsCamStream=null, clsCamInterval=null, clsAudioFromCam=false, clsCamFacing='user';
  const tBoard=document.getElementById('t-board');
  const tCtx=tBoard.getContext('2d');
  const CLS_BOARD_DEFAULT_W=900, CLS_BOARD_DEFAULT_H=560;

  function clsResizeBoard(){
    const ratio=tBoard.height/tBoard.width;
    const containerW=tBoard.parentElement.clientWidth;
    if(!containerW)return;
    const maxH=window.innerHeight*0.78; // بزرگ ولی همیشه در صفحه جا می‌شود (مثل نمایشگر PDF در Adobe Connect)
    let w=containerW, h=w*ratio;
    if(h>maxH){h=maxH;w=h/ratio;}
    tBoard.style.width=w+'px';
    tBoard.style.height=h+'px';
  }
  function clsResizeBoardTo(w,h){
    tBoard.width=Math.round(w);
    tBoard.height=Math.round(h);
    clsResizeBoard();
  }
  clsResizeBoard();window.addEventListener('resize',clsResizeBoard);

  function clsPointFromEvent(e){
    const rect=tBoard.getBoundingClientRect();
    const cx=(e.touches?e.touches[0].clientX:e.clientX)-rect.left;
    const cy=(e.touches?e.touches[0].clientY:e.clientY)-rect.top;
    return [cx/rect.width, cy/rect.height];
  }
  function clsDrawLocal(stroke){
    if(!stroke)return;
    if(stroke.type==='text'){
      tCtx.save();
      tCtx.fillStyle=stroke.color||'#111827';
      tCtx.font='bold '+((stroke.size||3)*7+12)+'px Vazirmatn, Tahoma, sans-serif';
      tCtx.textBaseline='top';
      tCtx.fillText(stroke.text||'', stroke.x*tBoard.width, stroke.y*tBoard.height);
      tCtx.restore();
      return;
    }
    if(!stroke.points||stroke.points.length<2)return;
    tCtx.save();
    tCtx.strokeStyle=stroke.erase?'#ffffff':(stroke.color||'#111827');
    tCtx.lineWidth=stroke.size||3;
    tCtx.lineCap='round';tCtx.lineJoin='round';
    tCtx.beginPath();
    tCtx.moveTo(stroke.points[0][0]*tBoard.width, stroke.points[0][1]*tBoard.height);
    for(let i=1;i<stroke.points.length;i++)tCtx.lineTo(stroke.points[i][0]*tBoard.width, stroke.points[i][1]*tBoard.height);
    tCtx.stroke();
    tCtx.restore();
  }
  function clsSend(obj){ if(clsWs && clsWs.readyState===1) clsWs.send(JSON.stringify(obj)); }

  // ===== لایه‌ی پس‌زمینه (صفحه‌ی PDF روی تخته) =====
  let clsBoardBgImg=null;
  function clsSetBoardBg(dataUrl,w,h){
    if(!dataUrl){
      clsBoardBgImg=null;
      clsResizeBoardTo(w||CLS_BOARD_DEFAULT_W,h||CLS_BOARD_DEFAULT_H);
      tCtx.clearRect(0,0,tBoard.width,tBoard.height);
      return;
    }
    const img=new Image();
    img.onload=()=>{
      clsBoardBgImg=img;
      clsResizeBoardTo(w||img.naturalWidth,h||img.naturalHeight);
      tCtx.clearRect(0,0,tBoard.width,tBoard.height);
      tCtx.drawImage(img,0,0,tBoard.width,tBoard.height);
    };
    img.onerror=()=>{toast('خطا در بارگذاری تصویر پس‌زمینه');};
    img.src=dataUrl;
  }
  function clsSetBoardBgAndReplay(dataUrl,strokes,w,h){
    if(!dataUrl){
      clsBoardBgImg=null;
      clsResizeBoardTo(w||CLS_BOARD_DEFAULT_W,h||CLS_BOARD_DEFAULT_H);
      tCtx.clearRect(0,0,tBoard.width,tBoard.height);
      (strokes||[]).forEach(clsDrawLocal);
      return;
    }
    const img=new Image();
    img.onload=()=>{
      clsBoardBgImg=img;
      clsResizeBoardTo(w||img.naturalWidth,h||img.naturalHeight);
      tCtx.clearRect(0,0,tBoard.width,tBoard.height);
      tCtx.drawImage(img,0,0,tBoard.width,tBoard.height);
      (strokes||[]).forEach(clsDrawLocal);
    };
    img.onerror=()=>{toast('خطا در بارگذاری تصویر پس‌زمینه');};
    img.src=dataUrl;
  }

  // ===== نمایش PDF روی تخته =====
  let clsPdfDoc=null, clsPdfFileName='', clsPdfCurrentPage=1;
  document.getElementById('cls-pdf-file').addEventListener('change',async function(){
    const f=this.files&&this.files[0];this.value='';
    if(!f)return;
    if(f.type!=='application/pdf'){toast('فقط فایل PDF مجاز است');return;}
    try{
      const buf=await f.arrayBuffer();
      clsPdfDoc=await pdfjsLib.getDocument({data:buf}).promise;
      clsPdfFileName=f.name;
      clsPdfCurrentPage=1;
      document.getElementById('cls-pdf-name').textContent=f.name;
      document.getElementById('cls-pdf-total').textContent=clsPdfDoc.numPages;
      const pn=document.getElementById('cls-pdf-pagenum');
      pn.value=1;pn.max=clsPdfDoc.numPages;
      document.getElementById('cls-pdf-nav').classList.remove('hidden');
      document.getElementById('cls-pdf-remove-file').classList.remove('hidden');
      toast('فایل PDF بارگذاری شد ✅ ('+clsPdfDoc.numPages+' صفحه)');
    }catch(e){
      toast('خطا در باز کردن فایل PDF - فایل معتبر است؟');
      clsPdfDoc=null;
    }
  });
  async function clsRenderPdfPage(pageNum){
    const page=await clsPdfDoc.getPage(pageNum);
    const baseViewport=page.getViewport({scale:1});
    async function renderAt(targetWidth,quality){
      const scale=targetWidth/baseViewport.width;
      const viewport=page.getViewport({scale});
      const canvas=document.createElement('canvas');
      canvas.width=viewport.width;canvas.height=viewport.height;
      const ctx=canvas.getContext('2d');
      ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
      await page.render({canvasContext:ctx,viewport}).promise;
      return {dataUrl:canvas.toDataURL('image/jpeg',quality), w:canvas.width, h:canvas.height};
    }
    // ابتدا با کیفیت بالا رندر می‌کنیم؛ اگر حجم نهایی برای ارسال زنده خیلی بزرگ شد، به‌صورت خودکار کیفیت را کمی کاهش می‌دهیم
    let result=await renderAt(1900,0.9);
    if(result.dataUrl.length>3_000_000){
      result=await renderAt(1500,0.82);
    }
    if(result.dataUrl.length>3_000_000){
      result=await renderAt(1100,0.75);
    }
    return result;
  }
  document.getElementById('cls-pdf-prev').onclick=()=>{
    if(!clsPdfDoc)return;
    clsPdfCurrentPage=Math.max(1,clsPdfCurrentPage-1);
    document.getElementById('cls-pdf-pagenum').value=clsPdfCurrentPage;
  };
  document.getElementById('cls-pdf-next').onclick=()=>{
    if(!clsPdfDoc)return;
    clsPdfCurrentPage=Math.min(clsPdfDoc.numPages,clsPdfCurrentPage+1);
    document.getElementById('cls-pdf-pagenum').value=clsPdfCurrentPage;
  };
  document.getElementById('cls-pdf-pagenum').addEventListener('change',function(){
    if(!clsPdfDoc)return;
    let v=parseInt(this.value,10)||1;
    v=Math.max(1,Math.min(clsPdfDoc.numPages,v));
    clsPdfCurrentPage=v;this.value=v;
  });
  document.getElementById('cls-pdf-show').onclick=async()=>{
    if(!clsPdfDoc){toast('ابتدا یک فایل PDF انتخاب کنید');return;}
    const btn=document.getElementById('cls-pdf-show');btn.disabled=true;const orig=btn.textContent;btn.textContent='⏳ در حال رندر...';
    try{
      const {dataUrl,w,h}=await clsRenderPdfPage(clsPdfCurrentPage);
      clsResizeBoardTo(w,h);
      clsSetBoardBg(dataUrl);
      clsSend({type:'board-bg',data:dataUrl,w,h});
      toast('صفحه '+clsPdfCurrentPage+' روی تخته نمایش داده شد ✅');
    }catch(e){
      toast('خطا در رندر این صفحه از PDF');
    }finally{
      btn.disabled=false;btn.textContent=orig;
    }
  };
  document.getElementById('cls-pdf-remove-bg').onclick=()=>{
    clsResizeBoardTo(CLS_BOARD_DEFAULT_W,CLS_BOARD_DEFAULT_H);
    clsSetBoardBg(null);
    clsSend({type:'board-bg',data:null,w:CLS_BOARD_DEFAULT_W,h:CLS_BOARD_DEFAULT_H});
    toast('PDF از روی تخته حذف شد');
  };
  document.getElementById('cls-pdf-remove-file').onclick=()=>{
    if(!confirm('فایل PDF بارگذاری‌شده حذف شود؟ (اگر روی تخته نمایش داده شده، آن هم حذف می‌شود)'))return;
    clsPdfDoc=null;clsPdfFileName='';clsPdfCurrentPage=1;
    document.getElementById('cls-pdf-name').textContent='';
    document.getElementById('cls-pdf-nav').classList.add('hidden');
    document.getElementById('cls-pdf-remove-file').classList.add('hidden');
    document.getElementById('cls-pdf-file').value='';
    if(clsBoardBgImg){clsResizeBoardTo(CLS_BOARD_DEFAULT_W,CLS_BOARD_DEFAULT_H);clsSetBoardBg(null);clsSend({type:'board-bg',data:null,w:CLS_BOARD_DEFAULT_W,h:CLS_BOARD_DEFAULT_H});}
    toast('فایل PDF حذف شد');
  };

  let brdMode='pen'; // pen | line | text | eraser
  let clsLineStart=null, clsLineSnapshot=null;
  function clsSetMode(mode){
    brdMode=mode;
    ['pen','line','text','eraser'].forEach(function(m){
      document.getElementById('brd-tool-'+m).classList.toggle('active', m===mode);
    });
  }
  document.getElementById('brd-tool-pen').onclick=function(){clsSetMode('pen');};
  document.getElementById('brd-tool-line').onclick=function(){clsSetMode('line');};
  document.getElementById('brd-tool-text').onclick=function(){clsSetMode('text');};
  document.getElementById('brd-tool-eraser').onclick=function(){clsSetMode('eraser');};

  function clsStartStroke(e){
    e.preventDefault();
    const pt=clsPointFromEvent(e);

    if(brdMode==='text'){
      const text=window.prompt('متن مورد نظر را بنویسید:');
      if(text && text.trim()){
        const stroke={ type:'text', text: text.trim(), x: pt[0], y: pt[1], color: document.getElementById('brd-color').value, size: parseInt(document.getElementById('brd-size').value)||3 };
        clsDrawLocal(stroke);
        clsSend({type:'draw', stroke});
      }
      return;
    }

    clsDrawing=true;
    if(brdMode==='line'){
      clsLineStart=pt;
      try{ clsLineSnapshot=tCtx.getImageData(0,0,tBoard.width,tBoard.height); }catch(err){ clsLineSnapshot=null; }
      return;
    }

    const eraseOn=brdMode==='eraser';
    clsCurrentStroke={ color: document.getElementById('brd-color').value, size: parseInt(document.getElementById('brd-size').value)||3, erase: eraseOn, points: [pt] };
  }
  function clsMoveStroke(e){
    if(!clsDrawing)return;
    e.preventDefault();
    const pt=clsPointFromEvent(e);

    if(brdMode==='line'){
      if(clsLineSnapshot) tCtx.putImageData(clsLineSnapshot,0,0);
      clsDrawLocal({ color: document.getElementById('brd-color').value, size: parseInt(document.getElementById('brd-size').value)||3, points:[clsLineStart, pt] });
      return;
    }

    clsCurrentStroke.points.push(pt);
    if(clsCurrentStroke.points.length>=2){
      const tail={ ...clsCurrentStroke, points: clsCurrentStroke.points.slice(-2) };
      clsDrawLocal(tail);
      clsSend({type:'draw', stroke: tail});
    }
  }
  function clsEndStroke(e){
    if(clsDrawing && brdMode==='line' && clsLineStart){
      const pt=clsPointFromEvent(e);
      if(clsLineSnapshot) tCtx.putImageData(clsLineSnapshot,0,0);
      const stroke={ color: document.getElementById('brd-color').value, size: parseInt(document.getElementById('brd-size').value)||3, points:[clsLineStart, pt] };
      clsDrawLocal(stroke);
      clsSend({type:'draw', stroke});
      clsLineStart=null; clsLineSnapshot=null;
    }
    clsDrawing=false; clsCurrentStroke=null;
  }

  tBoard.addEventListener('mousedown',clsStartStroke);
  tBoard.addEventListener('mousemove',clsMoveStroke);
  window.addEventListener('mouseup',clsEndStroke);
  tBoard.addEventListener('touchstart',clsStartStroke,{passive:false});
  tBoard.addEventListener('touchmove',clsMoveStroke,{passive:false});
  tBoard.addEventListener('touchend',clsEndStroke);

  document.getElementById('brd-clear').onclick=function(){
    tCtx.clearRect(0,0,tBoard.width,tBoard.height);
    if(clsBoardBgImg)tCtx.drawImage(clsBoardBgImg,0,0,tBoard.width,tBoard.height);
    clsSend({type:'clear'});
  };

  function clsAddChat(entry){
    const box=document.getElementById('t-chatBox');
    const cls=entry.role==='teacher'?'teacher':'student';
    box.insertAdjacentHTML('beforeend','<div class="msg '+cls+'" style="padding:6px 10px;border-radius:10px;max-width:90%;font-size:14px;'+(cls==='teacher'?'background:#eef2ff;align-self:flex-start':'background:#dcfce7;align-self:flex-end;margin-inline-start:auto')+'"><div class="who" style="font-size:11px;color:#666;margin-bottom:2px">'+esc(entry.from)+'</div>'+esc(entry.text)+'</div>');
    box.scrollTop=box.scrollHeight;
  }
  function clsAddFile(f){
    const box=document.getElementById('t-chatBox');
    const cls=f.role==='teacher'?'teacher':'student';
    const align=cls==='teacher'?'background:#eef2ff;align-self:flex-start':'background:#dcfce7;align-self:flex-end;margin-inline-start:auto';
    let inner;
    if((f.mime||'').indexOf('image/')===0){
      inner='<a href="'+f.data+'" download="'+esc(f.name)+'" target="_blank"><img src="'+f.data+'" style="max-width:180px;max-height:180px;border-radius:8px;display:block"></a>';
    } else {
      inner='<a href="'+f.data+'" download="'+esc(f.name)+'" style="color:#2563eb;text-decoration:underline">📎 '+esc(f.name)+'</a>';
    }
    box.insertAdjacentHTML('beforeend','<div class="msg '+cls+'" style="padding:6px 10px;border-radius:10px;max-width:90%;font-size:14px;'+align+'"><div class="who" style="font-size:11px;color:#666;margin-bottom:2px">'+esc(f.from)+'</div>'+inner+'</div>');
    box.scrollTop=box.scrollHeight;
  }
  document.getElementById('t-btnSend').onclick=()=>{
    const inp=document.getElementById('t-chatInput');
    const text=inp.value.trim();
    if(!text)return;
    clsSend({type:'chat', text});
    inp.value='';
  };
  document.getElementById('t-chatInput').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('t-btnSend').click();});
  document.getElementById('t-btnFile').onclick=()=>{document.getElementById('t-fileInput').click();};
  document.getElementById('t-fileInput').addEventListener('change',function(){
    const file=this.files&&this.files[0];
    this.value='';
    if(!file)return;
    if(file.size>2*1024*1024){toast('حجم فایل باید کمتر از ۲ مگابایت باشد');return;}
    const reader=new FileReader();
    reader.onload=function(){
      clsSend({type:'file', name:file.name, mime:file.type, data:reader.result});
    };
    reader.readAsDataURL(file);
  });

  function clsUpdateParticipants(list){
    document.getElementById('cls-online-count').textContent=list.filter(p=>p.role==='student').length;
    document.getElementById('cls-participants').innerHTML=list.map(p=>(p.role==='teacher'?'👨‍🏫 ':'👤 ')+esc(p.name)).join('<br>')||'<span class="muted">کسی متصل نیست</span>';
  }

  document.getElementById('btn-cls-start').onclick=async()=>{
    const startBtn=document.getElementById('btn-cls-start');
    startBtn.disabled=true;
    document.getElementById('t-cls-status').textContent='در حال بررسی...';
    try{
      const chk=await fetch('/api/classroom/ws?check=1&role=teacher');
      const chkData=await chk.json().catch(()=>({ok:false,error:'پاسخ نامعتبر از سرور'}));
      if(!chkData.ok){
        document.getElementById('t-cls-status').textContent='خطا: '+chkData.error;
        startBtn.disabled=false;
        toast(chkData.error);
        return;
      }
    }catch(e){
      document.getElementById('t-cls-status').textContent='خطا در ارتباط با سرور';
      startBtn.disabled=false;
      return;
    }
    startBtn.disabled=false;
    const proto=location.protocol==='https:'?'wss:':'ws:';
    clsWs=new WebSocket(proto+'//'+location.host+'/api/classroom/ws?role=teacher&name='+encodeURIComponent('معلم'));
    clsWs.onopen=()=>{
      document.getElementById('tdot').classList.add('on');
      document.getElementById('t-cls-status').textContent='کلاس آنلاین فعال است ✅';
      document.getElementById('btn-cls-start').classList.add('hidden');
      document.getElementById('btn-cls-stop').classList.remove('hidden');
      document.getElementById('btn-mic-toggle').classList.remove('hidden');
      document.getElementById('btn-cam-toggle').classList.remove('hidden');
      toast('کلاس آنلاین شروع شد');
    };
    clsWs.onclose=()=>{
      document.getElementById('tdot').classList.remove('on');
      document.getElementById('t-cls-status').textContent='کلاس آنلاین شروع نشده';
      document.getElementById('btn-cls-start').classList.remove('hidden');
      document.getElementById('btn-cls-stop').classList.add('hidden');
      document.getElementById('btn-mic-toggle').classList.add('hidden');
      document.getElementById('btn-cam-toggle').classList.add('hidden');
    };
    clsWs.onmessage=(evt)=>{
      let m;try{m=JSON.parse(evt.data);}catch(e){return;}
      if(m.type==='init'){
        if(m.boardBg){clsSetBoardBgAndReplay(m.boardBg,m.strokes||[]);}
        else{tCtx.clearRect(0,0,tBoard.width,tBoard.height);clsBoardBgImg=null;(m.strokes||[]).forEach(clsDrawLocal);}
        (m.chat||[]).forEach(clsAddChat);clsUpdateParticipants(m.participants||[]);
      }
      else if(m.type==='chat'){clsAddChat(m.entry);}
      else if(m.type==='file'){clsAddFile(m);}
      else if(m.type==='board-bg'){clsSetBoardBg(m.data);}
      else if(m.type==='error'){toast(m.message||'خطا');}
      else if(m.type==='presence'){clsUpdateParticipants(m.participants||[]);if(m.event==='join'&&m.role==='student')toast(m.name+' وارد کلاس شد');}
      else if(m.type==='raise-hand'){toast('✋ '+m.name+' دستش را بلند کرد');}
    };
  };
  document.getElementById('btn-cls-stop').onclick=()=>{
    if(clsRecorder&&clsRecorder.state!=='inactive')clsRecorder.stop();
    if(clsMicStream)clsMicStream.getTracks().forEach(t=>t.stop());
    clsMicStream=null;
    document.getElementById('btn-mic-toggle').textContent='🎙️ روشن کردن میکروفون';
    if(clsCamStream){clsCamStream.getTracks().forEach(t=>t.stop());clsCamStream=null;}
    if(clsCamInterval){clearInterval(clsCamInterval);clsCamInterval=null;}
    document.getElementById('t-cam-preview').classList.add('hidden');
    document.getElementById('t-cam-preview').srcObject=null;
    document.getElementById('btn-cam-toggle').textContent='📷 روشن کردن تصویر';
    document.getElementById('btn-cam-flip').classList.add('hidden');
    clsCamFacing='user';
    clsAudioFromCam=false;
    if(clsWs)clsWs.close();
  };

  document.getElementById('btn-cls-options-toggle').onclick=function(){
    document.getElementById('cls-options-drawer').classList.toggle('hidden');
  };

  function clsStartMicRecorder(stream){
    if(clsAudioActive) return; // جلوگیری از راه‌اندازی دوباره و همپوشانی صدا (علت اصلی تکرار صدا)
    clsMicStream=stream;
    clsAudioActive=true;
    clsAudioGen++;
    const myGen=clsAudioGen;
    const preferredMimes=['audio/webm;codecs=opus','audio/webm','audio/mp4'];
    const mime=preferredMimes.find(m=>window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    function recordOneChunk(){
      if(myGen!==clsAudioGen || !clsAudioActive || !clsMicStream) return;
      let chunks=[];
      let rec;
      try{ rec=new MediaRecorder(clsMicStream, mime?{mimeType:mime}:undefined); }
      catch(e){ clsAudioActive=false; toast('امکان ضبط صدا در این مرورگر نیست'); return; }
      rec.ondataavailable=(e)=>{ if(e.data && e.data.size>0) chunks.push(e.data); };
      rec.onstop=async()=>{
        if(myGen!==clsAudioGen) return; // این نسل صدا دیگر معتبر نیست (متوقف یا دوباره‌شروع‌شده)
        if(chunks.length){
          const blob=new Blob(chunks, {type: mime||'audio/webm'});
          const buf=await blob.arrayBuffer();
          let binary='';const bytes=new Uint8Array(buf);
          for(let i=0;i<bytes.length;i++)binary+=String.fromCharCode(bytes[i]);
          clsSend({type:'audio', data: btoa(binary), mime: mime||'audio/webm'});
        }
        if(clsAudioActive && myGen===clsAudioGen) setTimeout(recordOneChunk, 15);
      };
      rec.start();
      clsRecorder=rec;
      // هر قطعه یک فایل صوتی کامل و مستقل است (نه یک استریم پیوسته)، برای سازگاری بین مرورگرها
      // مدت کوتاه‌تر = تأخیر کمتر در شنیدن صدای معلم
      setTimeout(()=>{ if(rec.state==='recording') rec.stop(); }, 380);
    }
    recordOneChunk();
  }
  function clsStopMicRecorder(){
    clsAudioActive=false;
    clsAudioGen++; // هر حلقه‌ی در حال اجرا با چک نسل، خودش را متوقف می‌کند
    if(clsRecorder && clsRecorder.state==='recording')clsRecorder.stop();
    if(clsMicStream)clsMicStream.getTracks().forEach(t=>t.stop());
    clsMicStream=null;
    document.getElementById('btn-mic-toggle').textContent='🎙️ روشن کردن میکروفون';
  }

  document.getElementById('btn-mic-toggle').onclick=async function(){
    if(clsRecorder && clsRecorder.state==='recording'){
      clsStopMicRecorder();
      clsAudioFromCam=false;
      return;
    }
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      clsStartMicRecorder(stream);
      clsAudioFromCam=false;
      this.textContent='🔴 خاموش کردن میکروفون';
      toast('میکروفون فعال شد');
    }catch(e){ toast('دسترسی به میکروفون داده نشد'); }
  };

  document.getElementById('btn-cam-toggle').onclick=async function(){
    const preview=document.getElementById('t-cam-preview');
    if(clsCamStream){
      clsCamStream.getVideoTracks().forEach(t=>t.stop());
      clsCamStream=null;
      if(clsCamInterval){clearInterval(clsCamInterval);clsCamInterval=null;}
      preview.classList.add('hidden');
      preview.srcObject=null;
      this.textContent='📷 روشن کردن تصویر';
      document.getElementById('btn-cam-flip').classList.add('hidden');
      clsCamFacing='user';
      clsSend({type:'video-stop'});
      if(clsAudioFromCam){ clsStopMicRecorder(); clsAudioFromCam=false; }
      return;
    }
    try{
      clsCamStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:clsCamFacing,width:{ideal:320},height:{ideal:240}}, audio:true});
      preview.srcObject=clsCamStream;
      preview.classList.remove('hidden');
      this.textContent='🔴 خاموش کردن تصویر';
      document.getElementById('btn-cam-flip').classList.remove('hidden');
      // اگر میکروفون از قبل روشن نبود، صدا را هم همراه تصویر روشن کن (مثل یک تماس تصویری واقعی)
      if(!(clsRecorder && clsRecorder.state==='recording') && clsCamStream.getAudioTracks().length){
        clsStartMicRecorder(new MediaStream(clsCamStream.getAudioTracks()));
        clsAudioFromCam=true;
        document.getElementById('btn-mic-toggle').textContent='🔴 خاموش کردن میکروفون';
      }
      toast('تماس تصویری (با صدا) فعال شد');
      const cap=document.createElement('canvas');
      cap.width=320;cap.height=240;
      const capCtx=cap.getContext('2d');
      clsCamInterval=setInterval(function(){
        if(!clsCamStream)return;
        try{
          capCtx.drawImage(preview,0,0,cap.width,cap.height);
          const dataUrl=cap.toDataURL('image/jpeg',0.45);
          clsSend({type:'video-frame', data: dataUrl});
        }catch(e){}
      },220); // حدود ۴-۵ فریم در ثانیه؛ کافی برای تماس تصویری ساده کلاس درس
    }catch(e){ toast('دسترسی به دوربین یا میکروفون داده نشد'); }
  };

  document.getElementById('btn-cam-flip').onclick=async function(){
    if(!clsCamStream){toast('ابتدا دوربین را روشن کنید');return;}
    const preview=document.getElementById('t-cam-preview');
    const nextFacing=clsCamFacing==='user'?'environment':'user';
    try{
      const newStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:nextFacing,width:{ideal:320},height:{ideal:240}}, audio:true});
      const wasAudioFromCam=clsAudioFromCam;
      if(wasAudioFromCam){ clsStopMicRecorder(); clsAudioFromCam=false; }
      clsCamStream.getTracks().forEach(t=>t.stop());
      clsCamStream=newStream;
      clsCamFacing=nextFacing;
      preview.srcObject=clsCamStream;
      if(wasAudioFromCam && clsCamStream.getAudioTracks().length){
        clsStartMicRecorder(new MediaStream(clsCamStream.getAudioTracks()));
        clsAudioFromCam=true;
        document.getElementById('btn-mic-toggle').textContent='🔴 خاموش کردن میکروفون';
      }
      toast('دوربین عوض شد 🔄');
    }catch(e){ toast('چرخش دوربین در این دستگاه ممکن نیست'); }
  };

  // ===================== دفتر مدیریت کلاسی =====================
  // --- ناوبری منو ---
  document.querySelectorAll('.lb-menu-btn').forEach(function(b){
    b.onclick=function(){
      document.getElementById('lb-menu').classList.add('hidden');
      const panel=document.getElementById('lb-panel-'+b.dataset.lb);
      if(panel)panel.classList.remove('hidden');
      if(b.dataset.lb==='pacing'){lbRenderPacing();lbLoadPacingIfNeeded(lbSelectedGradeIdx());}
      if(b.dataset.lb==='roster')lbLoadRosterIfNeeded();
      if(b.dataset.lb==='genderstats')lbLoadGenderStatsIfNeeded();
      if(b.dataset.lb==='absence')lbLoadAbsenceIfNeeded();
      if(b.dataset.lb==='performance'){
        document.getElementById('lbf-form-wrap').classList.add('hidden');
        LB_PERF_CURRENT_UUID=null;
        lbRenderPerfStudentList(lbSelectedPerfGradeIdx());
      }
      if(b.dataset.lb==='council')lbLoadCouncilIfNeeded();
      if(b.dataset.lb==='meetings')lbLoadMeetingsIfNeeded();
      if(b.dataset.lb==='weekly')lbLoadWeeklyIfNeeded();
      if(b.dataset.lb==='weekly2')lbLoadWeekly2IfNeeded();
      if(b.dataset.lb==='staff')lbLoadStaffIfNeeded();
    };
  });
  document.querySelectorAll('.lb-back-btn').forEach(function(b){
    b.onclick=function(){
      document.querySelectorAll('.lb-panel').forEach(function(p){p.classList.add('hidden');});
      document.getElementById('lb-menu').classList.remove('hidden');
    };
  });

  // --- ابزارهای مشترک خروجی ---
  function lbMetaBlock(fields){ // fields: [[label,inputId]]
    return '<p class="lb-meta">'+fields.map(function(f){
      var el=document.getElementById(f[1]);
      var val=el?el.value:'';
      return '<b>'+f[0]+':</b> '+esc(val||'.......................')+'&nbsp;&nbsp;&nbsp;&nbsp;';
    }).join('')+'</p>';
  }
  function lbWordExport(title,bodyHtml,filename,landscape){
    var pageCss=landscape
      ? '@page Section1 {size:29.7cm 21cm;mso-page-orientation:landscape;margin:1.2cm} div.Section1{page:Section1}'
      : '@page Section1 {size:21cm 29.7cm;margin:1.5cm} div.Section1{page:Section1}';
    var style='<style>'+pageCss+' body{direction:rtl;font-family:tahoma,Arial;padding:6px}h1,h2,h3{text-align:center}table{width:100%;border-collapse:collapse;margin:10px 0}th,td{border:1px solid #333;padding:'+(landscape?'4px':'6px')+';text-align:center;font-size:'+(landscape?'10px':'12px')+'}th{background:#dbeafe}.lb-meta{margin-bottom:14px;font-size:14px}.lb-nowruz{background:#16a34a;color:#fff;font-weight:bold}.lb-table-zebra tbody tr:nth-child(odd){background:#f4f6f8}</style>';
    var blob=new Blob(['<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8">'+style+'<title>'+esc(title)+'</title></head><body><div class="Section1"><h2>'+esc(title)+'</h2>'+bodyHtml+'</div></body></html>'],{type:'application/msword'});
    var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename+'.doc';document.body.appendChild(a);a.click();a.remove();
  }
  function lbPrintExport(title,bodyHtml,landscape){
    var style='<style>@page{size:A4 '+(landscape===false?'portrait':'landscape')+';margin:8mm}body{direction:rtl;font-family:tahoma,Arial;padding:6px}h1,h2,h3{text-align:center}table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #333;padding:4px;text-align:center;font-size:10px}th{background:#dbeafe}.lb-meta{margin-bottom:10px;font-size:12px}.lb-nowruz{background:#16a34a;color:#fff;font-weight:bold}.lb-table-zebra tbody tr:nth-child(odd){background:#f4f6f8}</style>';
    var w=window.open('','_blank');
    if(!w){toast('اجازه‌ی باز کردن پنجره‌ی چاپ داده نشد (popup blocked)');return;}
    w.document.write('<html><head><meta charset="utf-8">'+style+'<title>'+esc(title)+'</title></head><body><h2>'+esc(title)+'</h2>'+bodyHtml+'</body></html>');
    w.document.close();
    setTimeout(function(){w.print();},500);
  }
  async function lbExcelExport(filename,buildFn){
    try{
      await loadExcelJS();
      var wb=new ExcelJS.Workbook();
      await buildFn(wb);
      var buf=await wb.xlsx.writeBuffer();
      var blob=new Blob([buf],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename+'.xlsx';document.body.appendChild(a);a.click();a.remove();
      toast('فایل اکسل ساخته شد ✅');
    }catch(e){toast('خطا در ساخت فایل اکسل');}
  }
  function lbAddExcelSheet(wb,sheetName,rows,styleHeader){
    var ws=wb.addWorksheet(sheetName.slice(0,31),{views:[{rightToLeft:true}]});
    rows.forEach(function(rowArr,ri){
      var row=ws.addRow(rowArr);
      if(ri===0 && styleHeader!==false){
        row.eachCell(function(cell){
          cell.font={bold:true};
          cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFDBEAFE'}};
          cell.alignment={horizontal:'center',vertical:'middle'};
        });
      }
    });
    ws.columns.forEach(function(col){
      var maxLen=10;
      col.eachCell({includeEmpty:true},function(cell){
        var len=(cell.value?String(cell.value).length:0);
        if(len>maxLen)maxLen=len;
      });
      col.width=Math.min(35,maxLen+3);
    });
    return ws;
  }

  // --- تبدیل جدول‌های پویا (ردیفی) به آرایه‌ی داده برای خروجی ---
  function lbTableToRows(tableEl){
    if(!tableEl)return [[]];
    var headers=Array.from(tableEl.querySelectorAll('thead th')).map(function(th){return th.textContent.trim();});
    var rows=[headers];
    tableEl.querySelectorAll('tbody tr').forEach(function(tr){
      var row=[];
      tr.querySelectorAll('td').forEach(function(td){
        var inp=td.querySelector('input,textarea');
        row.push(inp?inp.value:td.textContent.trim());
      });
      rows.push(row);
    });
    return rows;
  }
  // پاک کردن تمام مقادیر ورودی داخل یک جدول/بخش (بدون دست زدن به چک‌باکس‌ها)، با فراخوانی رویداد input تا داده‌های وابسته (LB_*_DATA) هم به‌روز شوند
  function lbClearContainer(containerId){
    if(!confirm('آیا از پاک‌کردن تمام اطلاعات این جدول مطمئن هستید؟ این کار قابل بازگشت نیست.'))return;
    var el=document.getElementById(containerId);
    if(!el)return;
    el.querySelectorAll('input,textarea').forEach(function(inp){
      if(inp.type==='checkbox'||inp.type==='radio')return;
      inp.value='';
      inp.dispatchEvent(new Event('input',{bubbles:true}));
    });
    toast('جدول پاک شد ✅');
  }
  window.lbClearContainer=lbClearContainer;
  function lbRowsToHtmlTable(rows){
    if(!rows.length)return '<table></table>';
    var h='<table><tr>'+rows[0].map(function(c){return '<th>'+esc(c)+'</th>';}).join('')+'</tr>';
    for(var i=1;i<rows.length;i++){
      h+='<tr>'+rows[i].map(function(c){return '<td>'+esc(c)+'</td>';}).join('')+'</tr>';
    }
    h+='</table>';
    return h;
  }
  function lbBuildSimpleTableHtml(headers,rowCount){
    var h='<thead><tr>'+headers.map(function(hd){return '<th>'+esc(hd)+'</th>';}).join('')+'</tr></thead><tbody>';
    for(var r=1;r<=rowCount;r++){
      h+='<tr><td>'+r+'</td>';
      for(var c=1;c<headers.length;c++){h+='<td><input type="text"></td>';}
      h+='</tr>';
    }
    h+='</tbody>';
    return h;
  }
  function lbAddSimpleRow(tableId,colCount){
    var tbody=document.querySelector('#'+tableId+' tbody');
    if(!tbody)return;
    var rowNum=tbody.children.length+1;
    var tr=document.createElement('tr');
    var html='<td>'+rowNum+'</td>';
    for(var c=1;c<colCount;c++)html+='<td><input type="text"></td>';
    tr.innerHTML=html;
    tbody.appendChild(tr);
  }
  // چسباندن هوشمند (مثل اکسل): چند مقدار کپی‌شده از یک ستون (یا چند ستون) را در خانه‌های زیرین/کناری پخش می‌کند
  // و در صورت نیاز، بدون پاک‌کردن داده‌های موجود، ردیف‌های جدید هم اضافه می‌کند
  function lbEnablePaste(tableId){
    var tableEl=document.getElementById(tableId);
    if(!tableEl)return;
    tableEl.addEventListener('paste',function(e){
      var target=e.target;
      if(!target||target.tagName!=='INPUT')return;
      var td=target.closest('td');var tr=td.closest('tr');var tbody=tr.parentElement;
      var tds=Array.from(tr.children);
      var colIdx=tds.indexOf(td);
      var rows=Array.from(tbody.children);
      var rowIdx=rows.indexOf(tr);
      var text=(e.clipboardData||window.clipboardData).getData('text');
      if(!text)return;
      var lines=text.replace(/\\r/g,'').split('\\n');
      while(lines.length>1&&lines[lines.length-1]==='')lines.pop();
      var grid=lines.map(function(l){return l.split('\\t');});
      var isMulti=grid.length>1||(grid[0]&&grid[0].length>1);
      if(!isMulti)return;
      e.preventDefault();
      var colCount=tds.length;
      var neededRows=rowIdx+grid.length;
      while(rows.length<neededRows){
        lbAddSimpleRow(tableId,colCount);
        rows=Array.from(tbody.children);
      }
      grid.forEach(function(rowArr,ri){
        var targetTr=rows[rowIdx+ri];
        if(!targetTr)return;
        var targetTds=Array.from(targetTr.children);
        rowArr.forEach(function(val,ci){
          var cc=colIdx+ci;
          if(cc>=targetTds.length||cc===0)return;
          var inp=targetTds[cc].querySelector('input,textarea');
          if(inp)inp.value=val.trim();
        });
      });
      toast('چسبانده شد: '+grid.length+' ردیف ✅');
    });
  }
  // ساخت دوباره‌ی جدول (مثلاً با تعداد ردیف جدید) بدون پاک شدن اطلاعاتی که قبلاً تایپ شده
  function lbRebuildPreserving(tableId,headers,rowCount){
    var tableEl=document.getElementById(tableId);
    var oldRows=tableEl.querySelector('tbody')?lbTableToRows(tableEl).slice(1):[];
    tableEl.innerHTML=lbBuildSimpleTableHtml(headers,rowCount);
    var trs=tableEl.querySelectorAll('tbody tr');
    trs.forEach(function(tr,rIdx){
      var oldRow=oldRows[rIdx];
      if(!oldRow)return;
      var tds=tr.querySelectorAll('td');
      tds.forEach(function(td,cIdx){
        if(cIdx===0)return; // ستون ردیف را دست نمی‌زنیم
        var inp=td.querySelector('input,textarea');
        if(inp && oldRow[cIdx]!==undefined)inp.value=oldRow[cIdx];
      });
    });
  }

  // پر کردن جدول از داده‌های ذخیره‌شده (بازیابی از سرور)
  function lbFillTableRows(tableId,dataRows){
    var tableEl=document.getElementById(tableId);
    if(!tableEl||!dataRows)return;
    var trs=tableEl.querySelectorAll('tbody tr');
    trs.forEach(function(tr,rIdx){
      var row=dataRows[rIdx];
      if(!row)return;
      var tds=tr.querySelectorAll('td');
      tds.forEach(function(td,cIdx){
        if(cIdx===0)return;
        var inp=td.querySelector('input,textarea');
        if(inp && row[cIdx]!==undefined)inp.value=row[cIdx];
      });
    });
  }

  // ===================== ۱. جدول بودجه‌بندی =====================
  var LB_GRADES=[
    {title:'پایه اول دبستان',subjects:['فارسی','نگارش فارسی','ریاضی','علوم تجربی','قرآن','هدیه‌های آسمان']},
    {title:'پایه دوم دبستان',subjects:['فارسی','نگارش فارسی','ریاضی','علوم تجربی','قرآن','هدیه‌های آسمان']},
    {title:'پایه سوم دبستان',subjects:['فارسی','نگارش فارسی','ریاضی','علوم تجربی','مطالعات اجتماعی','قرآن','هدیه‌های آسمان']},
    {title:'پایه چهارم دبستان',subjects:['فارسی','نگارش فارسی','ریاضی','علوم تجربی','مطالعات اجتماعی','قرآن','هدیه‌های آسمان']},
    {title:'پایه پنجم دبستان',subjects:['فارسی','نگارش فارسی','ریاضی','علوم تجربی','مطالعات اجتماعی','قرآن','هدیه‌های آسمان']},
    {title:'پایه ششم دبستان',subjects:['فارسی (بخوانیم)','نگارش فارسی','ریاضی','علوم تجربی','مطالعات اجتماعی','قرآن','هدیه‌های آسمان','کار و فناوری','تفکر و پژوهش']}
  ];
  var LB_MONTHS1=['مهر','آبان','آذر','دی'];
  var LB_MONTHS2=['بهمن','اسفند','فروردین','اردیبهشت'];
  var LB_PACING_DATA={}; // { gradeIdx: [ [16 مقدار برای هر سطر درس], ... ] } - نگه‌داری مقادیر تایپ‌شده هر پایه در حافظه
  function lbBuildPacingTableHtml(gradeIdx,forExport){
    var grade=LB_GRADES[gradeIdx];
    var subjects=grade.subjects;
    var saved=LB_PACING_DATA[gradeIdx];
    var h='<h3>'+esc(grade.title)+'</h3><div style="overflow-x:auto"><table class="lb-pacing-table"><thead>';
    h+='<tr><th rowspan="3">موضوع</th><th colspan="8">نوبت اول</th><th rowspan="3" class="lb-nowruz">تعطیلات<br>نوروز</th><th colspan="8">نوبت دوم</th></tr>';
    h+='<tr>'+LB_MONTHS1.map(function(m){return '<th colspan="2">'+m+'</th>';}).join('')+LB_MONTHS2.map(function(m){return '<th colspan="2">'+m+'</th>';}).join('')+'</tr>';
    h+='<tr>'+Array(8).fill('<th>نیمه۱</th><th>نیمه۲</th>').join('')+'</tr>';
    h+='</thead><tbody>';
    function cellHtml(rowIdx,colIdx){
      var val=(saved&&saved[rowIdx]&&saved[rowIdx][colIdx])||'';
      if(forExport)return '<td class="lb-cell">'+esc(val).replace(/\\n/g,'<br>')+'</td>';
      return '<td class="lb-cell"><textarea class="lb-pacing-input" data-grade="'+gradeIdx+'" data-row="'+rowIdx+'" data-col="'+colIdx+'" rows="3" placeholder="شماره درس / صفحات / زمان / توضیحات">'+esc(val)+'</textarea></td>';
    }
    subjects.forEach(function(subj,i){
      h+='<tr><td class="lb-subject">'+esc(subj)+'</td>';
      for(var c=0;c<8;c++)h+=cellHtml(i,c);
      if(i===0)h+='<td class="lb-nowruz" rowspan="'+subjects.length+'">تعطیلات<br>نوروز</td>';
      for(var c2=8;c2<16;c2++)h+=cellHtml(i,c2);
      h+='</tr>';
    });
    h+='</tbody></table></div>';
    return h;
  }
  function lbSelectedGradeIdx(){
    return parseInt(document.getElementById('lbp-grade-select').value,10)||0;
  }
  function lbSelectedGrade(){
    return LB_GRADES[lbSelectedGradeIdx()];
  }
  function lbRenderPacing(){
    var idx=lbSelectedGradeIdx();
    var el=document.getElementById('lb-pacing-preview');
    el.innerHTML=lbBuildPacingTableHtml(idx,false)+
      '<p><b>توضیحات:</b></p><p class="muted">این بودجه‌بندی پیشنهادی می‌باشد.</p>';
    // ذخیره‌ی زنده‌ی مقادیر تایپ‌شده در حافظه (تا با تغییر پایه از بین نروند)
    el.querySelectorAll('.lb-pacing-input').forEach(function(ta){
      ta.addEventListener('input',function(){
        var g=parseInt(ta.dataset.grade,10),r=parseInt(ta.dataset.row,10),c=parseInt(ta.dataset.col,10);
        if(!LB_PACING_DATA[g])LB_PACING_DATA[g]=[];
        if(!LB_PACING_DATA[g][r])LB_PACING_DATA[g][r]=[];
        LB_PACING_DATA[g][r][c]=ta.value;
      });
    });
  }
  var LB_PACING_LOADED={};
  async function lbLoadPacingIfNeeded(idx){
    if(LB_PACING_LOADED[idx])return;
    LB_PACING_LOADED[idx]=true;
    var saved=await lbLoad('pacing:'+idx);
    if(saved){
      if(saved.data)LB_PACING_DATA[idx]=saved.data;
      if(saved.meta){
        document.getElementById('lbp-school').value=saved.meta.school||'';
        document.getElementById('lbp-teacher').value=saved.meta.teacher||'';
        document.getElementById('lbp-year').value=saved.meta.year||'';
      }
      lbRenderPacing();
    }
  }
  document.getElementById('lbp-grade-select').addEventListener('change',function(){
    lbLoadPacingIfNeeded(lbSelectedGradeIdx()).then(lbRenderPacing);
  });
  document.getElementById('btn-lbp-save').onclick=function(){
    var idx=lbSelectedGradeIdx();
    lbSave('pacing:'+idx,{
      meta:{school:document.getElementById('lbp-school').value,teacher:document.getElementById('lbp-teacher').value,year:document.getElementById('lbp-year').value},
      data:LB_PACING_DATA[idx]||[]
    });
  };
  function lbPacingFullHtml(){
    var idx=lbSelectedGradeIdx();
    var grade=LB_GRADES[idx];
    var meta=lbMetaBlock([['نام مدرسه','lbp-school'],['نام آموزگار','lbp-teacher'],['سال تحصیلی','lbp-year']]);
    meta+='<p><b>پایه تحصیلی:</b> '+esc(grade.title)+'</p>';
    var table=lbBuildPacingTableHtml(idx,true);
    return meta+table+'<p><b>توضیحات:</b></p><p>این بودجه‌بندی پیشنهادی می‌باشد.</p>';
  }
  document.getElementById('btn-lb-pacing-word').onclick=function(){lbWordExport('جدول بودجه‌بندی آموزشی - '+lbSelectedGrade().title,lbPacingFullHtml(),'بودجه-بندی-'+lbSelectedGrade().title,true);};
  document.getElementById('btn-lb-pacing-pdf').onclick=function(){lbPrintExport('جدول بودجه‌بندی آموزشی - '+lbSelectedGrade().title,lbPacingFullHtml(),true);};
  document.getElementById('btn-lb-pacing-excel').onclick=function(){
    var idx=lbSelectedGradeIdx();
    var grade=LB_GRADES[idx];
    var saved=LB_PACING_DATA[idx]||[];
    lbExcelExport('بودجه-بندی-'+grade.title,function(wb){
      var headerRow1=['موضوع'].concat(LB_MONTHS1.reduce(function(a,m){return a.concat([m,'']);},[])).concat(['تعطیلات نوروز']).concat(LB_MONTHS2.reduce(function(a,m){return a.concat([m,'']);},[]));
      var headerRow2=[''].concat(Array(8).fill(0).map(function(_,i){return i%2===0?'نیمه۱':'نیمه۲';})).concat(['']).concat(Array(8).fill(0).map(function(_,i){return i%2===0?'نیمه۱':'نیمه۲';}));
      var rows=[headerRow1,headerRow2];
      grade.subjects.forEach(function(subj,i){
        var rowVals=saved[i]||[];
        var first8=[];for(var c=0;c<8;c++)first8.push(rowVals[c]||'');
        var second8=[];for(var c2=8;c2<16;c2++)second8.push(rowVals[c2]||'');
        rows.push([subj].concat(first8).concat(['']).concat(second8));
      });
      lbAddExcelSheet(wb,grade.title,rows);
    });
  };

  // ===================== ۲. لیست اسامی دانش‌آموزان =====================
  var LB_ROSTER_HEADERS=['ردیف','نام و نام خانوادگی دانش‌آموز','نام پدر','کد ملی','شماره تماس ولی','آدرس محل سکونت','توضیحات و پیگیری‌های لازم'];
  document.getElementById('btn-lbr-build').onclick=function(){
    var n=parseInt(document.getElementById('lbr-rows').value,10)||30;
    lbRebuildPreserving('lbr-table',LB_ROSTER_HEADERS,n);
  };
  document.getElementById('btn-lbr-addrow').onclick=function(){lbAddSimpleRow('lbr-table',LB_ROSTER_HEADERS.length);};
  document.getElementById('btn-lbr-build').click();
  lbEnablePaste('lbr-table');
  function lbRosterExportHtml(){
    var meta=lbMetaBlock([['نام مدرسه','lbr-school'],['نام آموزگار','lbr-teacher'],['پایه تحصیلی','lbr-grade'],['سال تحصیلی','lbr-year']]);
    var rows=lbTableToRows(document.getElementById('lbr-table'));
    return meta+lbRowsToHtmlTable(rows)+'<p style="margin-top:14px"><b>ادامه اسامی دانش‌آموزان</b></p>';
  }
  document.getElementById('btn-lb-roster-word').onclick=function(){lbWordExport('جدول لیست اسامی دانش‌آموزان',lbRosterExportHtml(),'لیست-اسامی-دانش-آموزان',true);};
  document.getElementById('btn-lb-roster-pdf').onclick=function(){lbPrintExport('جدول لیست اسامی دانش‌آموزان',lbRosterExportHtml(),true);};
  document.getElementById('btn-lb-roster-excel').onclick=function(){
    lbExcelExport('لیست-اسامی-دانش-آموزان',function(wb){
      lbAddExcelSheet(wb,'لیست اسامی',lbTableToRows(document.getElementById('lbr-table')));
    });
  };
  var LB_ROSTER_LOADED=false;
  async function lbLoadRosterIfNeeded(){
    if(LB_ROSTER_LOADED)return;
    LB_ROSTER_LOADED=true;
    var saved=await lbLoad('roster');
    if(!saved)return;
    if(saved.meta){
      document.getElementById('lbr-school').value=saved.meta.school||'';
      document.getElementById('lbr-teacher').value=saved.meta.teacher||'';
      document.getElementById('lbr-grade').value=saved.meta.grade||'';
      document.getElementById('lbr-year').value=saved.meta.year||'';
    }
    if(saved.rowCount){document.getElementById('lbr-rows').value=saved.rowCount;document.getElementById('btn-lbr-build').click();}
    if(saved.rows)lbFillTableRows('lbr-table',saved.rows);
  }
  document.getElementById('btn-lbr-save').onclick=function(){
    lbSave('roster',{
      meta:{school:document.getElementById('lbr-school').value,teacher:document.getElementById('lbr-teacher').value,grade:document.getElementById('lbr-grade').value,year:document.getElementById('lbr-year').value},
      rowCount:parseInt(document.getElementById('lbr-rows').value,10)||30,
      rows:lbTableToRows(document.getElementById('lbr-table')).slice(1)
    });
  };

  // ===================== آمار دانش‌آموزان به تفکیک جنسیت =====================
  var LBG_GRADE_NAMES=['اول','دوم','سوم','چهارم','پنجم','ششم'];
  function lbgRecalc(){
    var totalBoy=0,totalGirl=0;
    for(var g=1;g<=6;g++){
      var boyInp=document.querySelector('.lbg-boy[data-grade="'+g+'"]');
      var girlInp=document.querySelector('.lbg-girl[data-grade="'+g+'"]');
      var sumCell=document.querySelector('.lbg-sum[data-grade="'+g+'"]');
      var b=parseInt(toEnDigits(boyInp.value),10)||0;
      var gi=parseInt(toEnDigits(girlInp.value),10)||0;
      sumCell.textContent=toFaDigits(b+gi);
      totalBoy+=b;totalGirl+=gi;
    }
    document.getElementById('lbg-foot-boy').textContent=toFaDigits(totalBoy);
    document.getElementById('lbg-foot-girl').textContent=toFaDigits(totalGirl);
    document.getElementById('lbg-foot-all').textContent=toFaDigits(totalBoy+totalGirl);
    document.getElementById('lbg-total-boy').textContent=toFaDigits(totalBoy);
    document.getElementById('lbg-total-girl').textContent=toFaDigits(totalGirl);
    document.getElementById('lbg-total-all').textContent=toFaDigits(totalBoy+totalGirl);
  }
  document.getElementById('lbg-table').addEventListener('input',function(e){
    if(e.target && (e.target.classList.contains('lbg-boy')||e.target.classList.contains('lbg-girl'))){
      // فقط رقم مجاز است؛ هر عددی که تایپ می‌شود بلافاصله به رقم فارسی تبدیل می‌شود
      var cleaned=toEnDigits(e.target.value).replace(/[^0-9]/g,'').slice(0,3);
      e.target.value=toFaDigits(cleaned);
      lbgRecalc();
    }
  });

  var LB_GENDERSTATS_LOADED=false;
  async function lbLoadGenderStatsIfNeeded(){
    if(LB_GENDERSTATS_LOADED)return;
    LB_GENDERSTATS_LOADED=true;
    var saved=await lbLoad('genderstats');
    if(!saved)return;
    document.getElementById('lbg-school').value=saved.school||'';
    document.getElementById('lbg-year').value=saved.year||'';
    if(saved.grades){
      saved.grades.forEach(function(row,idx){
        var g=idx+1;
        var boyInp=document.querySelector('.lbg-boy[data-grade="'+g+'"]');
        var girlInp=document.querySelector('.lbg-girl[data-grade="'+g+'"]');
        if(boyInp)boyInp.value=toFaDigits(toEnDigits(row.boy||''));
        if(girlInp)girlInp.value=toFaDigits(toEnDigits(row.girl||''));
      });
    }
    lbgRecalc();
  }
  document.getElementById('btn-lbg-save').onclick=function(){
    var grades=[];
    for(var g=1;g<=6;g++){
      var boyInp=document.querySelector('.lbg-boy[data-grade="'+g+'"]');
      var girlInp=document.querySelector('.lbg-girl[data-grade="'+g+'"]');
      grades.push({boy:boyInp.value,girl:girlInp.value});
    }
    lbSave('genderstats',{school:document.getElementById('lbg-school').value,year:document.getElementById('lbg-year').value,grades:grades});
  };
  function lbgExportHtml(){
    var school=document.getElementById('lbg-school').value||'.......................';
    var year=document.getElementById('lbg-year').value||'.......................';
    var h='<p style="text-align:center;font-weight:bold;font-size:15px">آمار دانش‌آموزان مدرسه '+esc(school)+' به تفکیک جنسیت سال تحصیلی '+esc(year)+'</p>';
    h+='<table><tr><th>پایه</th><th>پسر</th><th>دختر</th><th>مجموع</th></tr>';
    var totalBoy=0,totalGirl=0;
    LBG_GRADE_NAMES.forEach(function(name,idx){
      var g=idx+1;
      var b=parseInt(toEnDigits(document.querySelector('.lbg-boy[data-grade="'+g+'"]').value),10)||0;
      var gi=parseInt(toEnDigits(document.querySelector('.lbg-girl[data-grade="'+g+'"]').value),10)||0;
      totalBoy+=b;totalGirl+=gi;
      h+='<tr><td>'+name+'</td><td>'+b+'</td><td>'+gi+'</td><td>'+(b+gi)+'</td></tr>';
    });
    h+='<tr style="font-weight:bold;background:#dbeafe"><td>مجموع کل</td><td>'+totalBoy+'</td><td>'+totalGirl+'</td><td>'+(totalBoy+totalGirl)+'</td></tr>';
    h+='</table>';
    h+='<p style="margin-top:16px">تعداد دانش‌آموزان پسر: <b>'+totalBoy+'</b>&nbsp;&nbsp;&nbsp;&nbsp;تعداد دانش‌آموزان دختر: <b>'+totalGirl+'</b>&nbsp;&nbsp;&nbsp;&nbsp;تعداد کل دانش‌آموزان مدرسه: <b>'+(totalBoy+totalGirl)+'</b></p>';
    return h;
  }
  document.getElementById('btn-lbg-word').onclick=function(){lbWordExport('آمار دانش‌آموزان به تفکیک جنسیت',lbgExportHtml(),'آمار-دانش-آموزان',false);};
  document.getElementById('btn-lbg-pdf').onclick=function(){lbPrintExport('آمار دانش‌آموزان به تفکیک جنسیت',lbgExportHtml(),false);};
  document.getElementById('btn-lbg-excel').onclick=function(){
    lbExcelExport('آمار-دانش-آموزان',function(wb){
      var rows=[['پایه','پسر','دختر','مجموع']];
      var totalBoy=0,totalGirl=0;
      LBG_GRADE_NAMES.forEach(function(name,idx){
        var g=idx+1;
        var b=parseInt(toEnDigits(document.querySelector('.lbg-boy[data-grade="'+g+'"]').value),10)||0;
        var gi=parseInt(toEnDigits(document.querySelector('.lbg-girl[data-grade="'+g+'"]').value),10)||0;
        totalBoy+=b;totalGirl+=gi;
        rows.push([name,b,gi,b+gi]);
      });
      rows.push(['مجموع کل',totalBoy,totalGirl,totalBoy+totalGirl]);
      lbAddExcelSheet(wb,'آمار دانش‌آموزان',rows);
    });
  };

  // ===================== ۳. ثبت غیبت =====================
  document.getElementById('btn-lba-build').onclick=function(){
    var days=parseInt(document.getElementById('lba-days').value,10)||30;
    var n=parseInt(document.getElementById('lba-rows').value,10)||30;
    var headers=['ردیف','نام و نام خانوادگی'];
    for(var d=1;d<=days;d++)headers.push(String(d));
    lbRebuildPreserving('lba-table',headers,n);
  };
  document.getElementById('btn-lba-addrow').onclick=function(){
    var days=parseInt(document.getElementById('lba-days').value,10)||30;
    lbAddSimpleRow('lba-table',days+2);
  };
  document.getElementById('btn-lba-build').click();
  function lbAbsenceExportHtml(){
    var month=document.getElementById('lba-month').value;
    var meta=lbMetaBlock([['نام مدرسه','lba-school'],['نام آموزگار','lba-teacher'],['پایه تحصیلی','lba-grade'],['سال تحصیلی','lba-year']]);
    meta+='<p><b>ماه:</b> '+esc(month)+' &nbsp;&nbsp; موجه: «م» | غیرموجه: «غ» | تأخیر: «ت»</p>';
    var rows=lbTableToRows(document.getElementById('lba-table'));
    return meta+lbRowsToHtmlTable(rows)+'<p style="margin-top:14px"><b>ادامه جدول غیبت دانش‌آموزان</b></p>';
  }
  document.getElementById('btn-lb-absence-word').onclick=function(){lbWordExport('جدول ثبت غیبت دانش‌آموزان',lbAbsenceExportHtml(),'ثبت-غیبت-دانش-آموزان',true);};
  document.getElementById('btn-lb-absence-pdf').onclick=function(){lbPrintExport('جدول ثبت غیبت دانش‌آموزان',lbAbsenceExportHtml(),true);};
  document.getElementById('btn-lb-absence-excel').onclick=function(){
    lbExcelExport('ثبت-غیبت-دانش-آموزان',function(wb){
      lbAddExcelSheet(wb,'ثبت غیبت',lbTableToRows(document.getElementById('lba-table')));
    });
  };
  var LB_ABSENCE_LOADED=false;
  async function lbLoadAbsenceIfNeeded(){
    if(LB_ABSENCE_LOADED)return;
    LB_ABSENCE_LOADED=true;
    var saved=await lbLoad('absence');
    if(!saved)return;
    if(saved.meta){
      document.getElementById('lba-school').value=saved.meta.school||'';
      document.getElementById('lba-teacher').value=saved.meta.teacher||'';
      document.getElementById('lba-grade').value=saved.meta.grade||'';
      document.getElementById('lba-year').value=saved.meta.year||'';
    }
    if(saved.month)document.getElementById('lba-month').value=saved.month;
    if(saved.days){document.getElementById('lba-days').value=saved.days;}
    if(saved.rowCount){document.getElementById('lba-rows').value=saved.rowCount;}
    if(saved.days||saved.rowCount)document.getElementById('btn-lba-build').click();
    if(saved.rows)lbFillTableRows('lba-table',saved.rows);
  }
  document.getElementById('btn-lba-save').onclick=function(){
    lbSave('absence',{
      meta:{school:document.getElementById('lba-school').value,teacher:document.getElementById('lba-teacher').value,grade:document.getElementById('lba-grade').value,year:document.getElementById('lba-year').value},
      month:document.getElementById('lba-month').value,
      days:parseInt(document.getElementById('lba-days').value,10)||30,
      rowCount:parseInt(document.getElementById('lba-rows').value,10)||30,
      rows:lbTableToRows(document.getElementById('lba-table')).slice(1)
    });
  };

  // ===================== ۴. ثبت سطوح عملکرد دانش‌آموز (جدول شماره ۸) =====================
  // انتظارات آموزشی واقعی هر درس به تفکیک پایه (طبق جدول شماره ۷) - مقدار null یعنی این درس در این پایه تدریس نمی‌شود
  var LB_PERF_SUBJECTS_BY_GRADE=[
    {name:"قرآن",grades:[["جمع‌خوانی","روخوانی","آداب قرآن خواندن","پیام قرآنی","داستان‌های قرآنی"],["روخوانی","قرائت","آداب قرآن خواندن","پیام قرآنی","داستان‌های قرآنی"],["روخوانی","قرائت","آداب قرآن خواندن","پیام قرآنی","داستان‌های قرآنی"],["روخوانی","قرائت","ترجمه کلمات و عبارات قرآنی","پیام قرآنی","داستان‌های قرآنی"],["روخوانی","قرائت","ترجمه کلمات و عبارات قرآنی","پیام قرآنی","داستان‌های قرآنی"],["روخوانی","قرائت","ترجمه کلمات و عبارات قرآنی","پیام قرآنی","داستان‌های قرآنی"]]},
    {name:"هدیه‌های آسمان",grades:[null,["خداشناسی و تشکر از خدا","آشنایی با پیامبران و امامان","آشنایی با صفات و اخلاق خوب و مطلوب","آشنایی با وضو، نماز و انجام صحیح آن","توجه به مناسبت‌ها"],["تشکر از خدا","آشنایی با زندگی‌نامه پیامبران و امامان","آشنایی با روزه و نماز و جشن تکلیف","سرلوحه قرار دادن قرآن در زندگی"],["تشکر از خدا","آشنایی با زندگی‌نامه پیامبران و امامان","آشنایی با تیمم، نماز جماعت و نمازهای مناسبتی","قرآن در زندگی"],["تشکر از خدا و نظم در آفریده‌هایش","آشنایی با زندگی‌نامه پیامبران و امامان","آشنایی با صفات خوب و عمل به آن","نماز جمعه و تفاوت آن با سایر نمازهای روزانه","سرلوحه قرار دادن قرآن در زندگی"],["تشکر از خدا و نظم در آفریده‌هایش","آشنایی با زندگی‌نامه پیامبران و امامان","آشنایی با صفات خوب و عمل به آن","فروع دین، نماز مسافر و اعیاد مسلمانان","سرلوحه قرار دادن قرآن در زندگی"]]},
    {name:"فارسی",grades:[["گوش دادن","سخن گفتن","تصویرخوانی","خواندن","زیبانویسی","درست‌نویسی","جمله‌سازی"],["گوش دادن","سخن گفتن","خواندن","درست‌نویسی و املا","جمله‌سازی"],["گوش دادن","سخن گفتن","خواندن","درست‌نویسی و املا","انشا و نگارش"],["گوش دادن","سخن گفتن","خواندن","درست‌نویسی و املا","انشا و نگارش"],["گوش دادن","سخن گفتن","خواندن","درست‌نویسی و املا","انشا و نگارش"],["گوش دادن","سخن گفتن","خواندن","درست‌نویسی و املا","انشا و نگارش"]]},
    {name:"ریاضی",grades:[["شمارش تا اعداد سه رقمی","مقایسه اعداد","جمع و تفریق","موقعیت مکانی","اشکال هندسی","تقارن","طول","زمان","جرم","سرشماری و جدول داده‌ها","نمودار ستونی","راهبردهای حل مسئله","حل مسئله","مربع شگفت‌انگیز"],["شمارش تا عدد ۴ رقمی","پول و واحدهای آن","مقایسه اعداد","اعداد تقریبی","کسر","جمع و تفریق فرآیندی و تکنیکی","اشکال هندسی","تقارن","طول","زمان","آمار و سرشماری","رسم نمودار","احتمال","راهبردهای حل مسئله","حل مسئله"],["شمارش تا عدد ۵ رقمی","پول","مقایسه اعداد","اعداد تقریبی","کسر","مقایسه کسر","جمع","تفریق","ضرب","تقسیم","احجام","دایره","زاویه","خطوط","چندضلعی‌ها","تقارن","طول و محیط","مساحت","جرم","زمان","جدول داده‌ها","رسم نمودار","احتمال","راهبردهای حل مسئله","حل مسئله"],["الگوها","شمارش تا عدد ده رقمی","کسر و عدد مخلوط","عدد اعشاری تا یک رقم اعشار","مقایسه اعداد","مقایسه کسر و عدد مخلوط","جمع","تفریق","ضرب","تقسیم اعداد طبیعی","جمع، تفریق، ضرب کسر و اعداد مخلوط","بخش‌پذیری","محاسبه‌های تقریبی","زاویه","عمود و موازی","چهارضلعی‌ها","زاویه","زمان","طول و محیط","مساحت","نمودار خط شکسته","احتمال وقوع یک پیشامد","راهبردهای حل مسئله","حل مسئله","ترکیب راهبردها"],["الگوها","شمارش تا عدد سیزده رقمی","کسر و عدد مخلوط","عدد اعشاری تا یک رقم اعشار","مقایسه اعداد","اعداد مخلوط","اعداد اعشاری","جمع و تفریق عددهای مرکب، مخلوط و اعشاری","ضرب کسرها، اعداد مخلوط و اعداد اعشاری","تقسیم کسرها","نسبت و تناسب","درصد","تقارن محوری-مرکزی","نیمساز","خواص چندضلعی‌ها","محیط دایره","مساحت لوزی و ذوزنقه","حجم و گنجایش","جمع‌آوری داده‌ها و رسم نمودار","میانگین","احتمال","راهبردهای حل مسئله","حل مسئله"],["الگوها","شمارش تا عدد سیزده رقمی","کسر و عدد مخلوط","عدد اعشاری تا یک رقم اعشار","مقایسه اعداد صحیح","اعداد مخلوط","اعداد اعشاری","جمع، تفریق و ضرب عددهای صحیح، مخلوط و اعشاری","تقسیم کسرها، اعداد اعشاری","نسبت و تناسب","درصد","تقارن","دوران","مختصات","طول و سطح","جرم و حجم","خط و زاویه","راهبردهای حل مسئله","حل مسئله"]]},
    {name:"علوم",grades:[["زنگ علوم","سلام به من نگاه کن","چه می‌خواهم بسازم","از گذشته تا آینده","سالم باش","دنیای جانوران","دنیای گیاهان","زمین خانه پرآب","سنگی، خاکی","ما در اطراف ما هوا وجود دارد","دنیای سرد و گرم","از خانه تا مدرسه","آهن‌ربای من"],["زنگ علوم","ساخت وسیله","نان","زندگی ما و گردش زمین","صدا","نور","سوخت‌ها","هوای سالم، آب سالم","سرگذشت دانه","درون آشیانه‌ها","تغییرات بدن","مواد پرکاربرد","تأثیر آب بر مواد"],["زنگ علوم","ساخت وسیله‌ای با سه آینه","روش‌های مختلف نگهداری مواد غذایی","آب ماده باارزش","زندگی ما و آب","نور","نیرو","خوراکی‌ها","گیاهان","جانوران","مواد اطراف ما","اندازه‌گیری مواد"],["زنگ علوم","سنگ‌ها","آسمان شب","انرژی","انرژی الکتریکی","گرما و ماده","آهن‌ربا در زندگی","بدن ما","بی‌مهره‌ها","گوناگونی گیاهان","زیستگاه","مخلوط‌ها"],["زنگ علوم","برگی از تاریخ","خاک باارزش","تجزیه نور و کاربرد عدسی","اهرم، ماشین‌های ساده و مرکب","حرکت بدن","ساختمان چشم و گوش","حواس","بکارید و بخورید","ریشه تا برگ","ماده تغییر می‌کند","ارتباط، احساسات و عواطف و ضرورت وجود و رعایت آنها در بین افراد جامعه"],["روش علمی","ساخت وسایل متحرک","تغییرات فناوری در طول زمان","سفر به اعماق زمین","زمین پویا","ورزش و نیرو","سفر انرژی","میکروسکوپ","شگفتی‌های برگ","جنگل","سالم بمانیم","سرگذشت دفتر من","کارخانه کاغذسازی"]]},
    {name:"اجتماعی",grades:[null,null,["ضرورت نظم و مقررات در مکان‌های مختلف","نهادهای اجتماعی","شناخت فردی خود","آموزه‌های دینی و اخلاقی در مورد اعضای خانواده و مدرسه","تغییرات خود و محیط پیرامون","رابطه متقابل انسان و محیط","انواع مشاغل","منابع طبیعی","حقوق افراد"],["محله","شناخت نمادهای ملی","تقویم","ویژگی‌های شخصیتی امام خمینی","انواع زندگی","مورخان و باستان‌شناسان","سلسله‌های باستانی","ناهمواری‌ها","آب و هوا","امکانات عمومی محله","برنامه‌ریزی و خرید","پوشش گیاهی نواحی مختلف"],["مناسبت‌ها","شهرها و کشورهای مذهبی","ایران بعد از اسلام","آثار باستانی و شخصیت‌های ملی","آشنایی با همسایگان ایران","قاره‌ها","آشنایی با ایران به تفکیک سرفصل‌ها"],["تصمیم‌گیری","برنامه‌ریزی","دوست‌یابی","صفویه","دوره اسلامی","آداب و آموزه‌های دینی","استعمار","جنگ تحمیلی","تغییرات پدیده‌های زندگی","کشاورزی","دریاها و همسایگان ایران","مشاغل","تولید و مصرف","منابع انرژی"]]},
    {name:"تفکر و پژوهش",grades:[null,null,null,null,null,["تصمیم‌گیری و انتخاب آگاهانه","آشنایی با روند انجام پژوهش","آشنایی با سیستم و اجرای آنها","تفکر در هویت و ارزش‌های ایرانی و ملی"]]},
    {name:"کار و فناوری",grades:[null,null,null,null,null,["آشنایی با رایانه و استفاده مطلوب و بهینه از آن","دست‌ورزی و ارتباط آن با اقتصاد و درآمدزایی"]]},
    {name:"هنر",grades:[["زیبایی‌شناسی","ارتباط با طبیعت","تولید و نقد هنری","آشنایی با میراث فرهنگی","کاربرد درست ابزار","رعایت ایمنی"],["زیبایی‌شناسی","ارتباط با طبیعت","تولید و نقد هنری","آشنایی با میراث فرهنگی","کاربرد درست ابزار","رعایت ایمنی"],["زیبایی‌شناسی","ارتباط با طبیعت","تولید و نقد هنری","آشنایی با میراث فرهنگی","کاربرد درست ابزار","رعایت ایمنی"],["زیبایی‌شناسی","ارتباط با طبیعت","تولید و نقد هنری","آشنایی با میراث فرهنگی","کاربرد درست ابزار","رعایت ایمنی"],["زیبایی‌شناسی","ارتباط با طبیعت","تولید و نقد هنری","آشنایی با میراث فرهنگی","کاربرد درست ابزار","رعایت ایمنی"],["زیبایی‌شناسی","ارتباط با طبیعت","تولید و نقد هنری","آشنایی با میراث فرهنگی","کاربرد درست ابزار","رعایت ایمنی"]]},
    {name:"تربیت بدنی",grades:[["توسعه و بهبود عضلانی","تعادل","قلبی-عروقی","انعطاف‌پذیری","کسب مهارت در جهت‌یابی","راه رفتن، ایستادن و نشستن","دویدن","پرتاب و چرخیدن"],["توسعه و بهبود عضلانی","تعادل","قلبی-تنفسی","انعطاف‌پذیری","چابکی","کسب مهارت در خم و راست شدن","پریدن","به پهلو دویدن","پرتاب دو دست","لی‌لی کردن"],["توسعه و بهبود عضلانی","تعادل","قلبی-تنفسی","انعطاف‌پذیری","چابکی","کسب مهارت در خم و راست شدن","پریدن","به پهلو دویدن","پرتاب دو دست","لی‌لی"],["توسعه و بهبود قلبی-تنفسی","عضلانی","انعطاف‌پذیری","سرعت","بهداشت و ایمنی","کسب مهارت‌های فوتبال","والیبال","تنیس روی میز","طناب‌زنی","شرکت در فعالیت‌ها"],["توسعه و بهبود قلبی-تنفسی","انعطاف‌پذیری","سرعت","بهداشت و ایمنی در ورزش","کسب مهارت‌های بسکتبال","هندبال","بدمینتون","طناب‌زنی","شرکت در فعالیت‌ها"],["توسعه و بهبود قلبی-تنفسی","انعطاف‌پذیری","عضلانی","بهداشت و ایمنی در ورزش","کسب مهارت‌های دو سرعت و مارپیچ","پرش","پرتاب","بازی‌های بومی و محلی"]]},
    {name:"شایستگی‌های عمومی",grades:[["رعایت بهداشت و ایمنی","رعایت آموخته‌های اخلاقی","مسئولیت‌پذیری","مشارکت در کار گروهی","احترام به ارزش‌های ملی و مذهبی","توجه به مطالعه و کتابخوانی","تلاش برای یادگیری بیشتر"],["رعایت بهداشت و ایمنی","توجه به مطالعه برای یادگیری بیشتر","رعایت آموخته‌های اخلاقی","مسئولیت‌پذیری","مشارکت در کار گروهی","احترام به ارزش‌ها"],["رعایت بهداشت و ایمنی","توجه به مطالعه و کتابخوانی","تلاش برای یادگیری بیشتر","رعایت آموخته‌های اخلاقی","مسئولیت‌پذیری","مشارکت در کار گروهی","احترام به ارزش‌های ملی و مذهبی"],["رعایت بهداشت و ایمنی","توجه به مطالعه برای یادگیری بیشتر","رعایت آموخته‌های اخلاقی","مشارکت","مسئولیت‌پذیری","احترام به ارزش‌ها"],["رعایت بهداشت","توجه به مطالعه","رعایت آموخته‌های اخلاقی","مشارکت","مسئولیت‌پذیری","احترام به ارزش‌ها"],["رعایت بهداشت","توجه به مطالعه","رعایت آموخته‌های اخلاقی","مشارکت","مسئولیت‌پذیری","احترام به ارزش‌ها"]]},
  ];
  var LB_PERF_DATA={}; // { 'subjectName-rowIdx': {expect:'', desc:'', cols:['','', ...]} } - داده‌های دانش‌آموزِ در حال ویرایش
  var LB_PERF_CURRENT_UUID=null; // شناسه‌ی دانش‌آموزِ در حال ویرایش (null یعنی هنوز ذخیره نشده / جدید است)
  function lbPerfColsCount(){
    return parseInt(document.getElementById('lbf-cols').value,10)||12;
  }
  function lbSelectedPerfGradeIdx(){
    return parseInt(document.getElementById('lbf-grade-select').value,10)||0;
  }
  // فهرست دروس تدریس‌شده در پایه‌ی انتخاب‌شده، همراه با انتظارات آموزشی واقعی هر درس
  function lbPerfActiveSubjects(gradeIdx){
    var out=[];
    LB_PERF_SUBJECTS_BY_GRADE.forEach(function(subj){
      var items=subj.grades[gradeIdx];
      if(items && items.length)out.push({name:subj.name,items:items});
    });
    return out;
  }
  function lbBuildPerformanceHtml(forExport,colsCount){
    var cols=colsCount||lbPerfColsCount();
    var subjects=lbPerfActiveSubjects(lbSelectedPerfGradeIdx());
    var h='<table class="lb-table lb-table-tight"><thead>';
    h+='<tr><th rowspan="2">نام درس</th><th rowspan="2">مهم‌ترین انتظارات آموزشی</th><th colspan="'+cols+'">ثبت عملکرد دانش‌آموز</th><th rowspan="2" style="width:70px;max-width:70px">توصیف کوتاه موارد ضروری</th></tr>';
    h+='<tr>';
    for(var c=0;c<cols;c++){
      h+=forExport?'<th style="min-width:22px">'+(c+1)+'</th>':'<th style="min-width:34px">'+(c+1)+'</th>';
    }
    h+='</tr></thead><tbody id="lb-perf-tbody">';
    subjects.forEach(function(subj){
      var key=subj.name;
      var saved=LB_PERF_DATA[key]||{};
      var defaultExpect=subj.items.join('، ');
      var expectVal=(saved.expect!==undefined)?saved.expect:defaultExpect;
      h+='<tr data-subj="'+esc(subj.name)+'">';
      h+='<td style="font-weight:700;background:#f1f5f9">'+esc(subj.name)+'</td>';
      h+=forExport?'<td style="text-align:right">'+esc(expectVal)+'</td>':'<td><textarea class="lb-perf-expect" data-key="'+key+'" rows="3" placeholder="انتظار آموزشی">'+esc(expectVal)+'</textarea></td>';
      for(var c2=0;c2<cols;c2++){
        var v=(saved.cols&&saved.cols[c2])||'';
        h+=forExport?'<td>'+esc(v)+'</td>':'<td><input type="text" class="lb-perf-cell" data-key="'+key+'" data-col="'+c2+'" value="'+esc(v)+'"></td>';
      }
      h+=forExport?'<td style="width:70px;max-width:70px;font-size:10px">'+esc(saved.desc||'')+'</td>':'<td style="width:70px;max-width:70px"><textarea class="lb-perf-desc" data-key="'+key+'" rows="3" style="width:70px" placeholder="توضیح کوتاه">'+esc(saved.desc||'')+'</textarea></td>';
      h+='</tr>';
    });
    h+='</tbody></table>';
    return h;
  }
  function lbBindPerformanceInputs(el){
    el.querySelectorAll('.lb-perf-expect').forEach(function(ta){
      ta.addEventListener('input',function(){
        if(!LB_PERF_DATA[ta.dataset.key])LB_PERF_DATA[ta.dataset.key]={};
        LB_PERF_DATA[ta.dataset.key].expect=ta.value;
      });
    });
    el.querySelectorAll('.lb-perf-desc').forEach(function(ta){
      ta.addEventListener('input',function(){
        if(!LB_PERF_DATA[ta.dataset.key])LB_PERF_DATA[ta.dataset.key]={};
        LB_PERF_DATA[ta.dataset.key].desc=ta.value;
      });
    });
    el.querySelectorAll('.lb-perf-cell').forEach(function(inp){
      inp.addEventListener('input',function(){
        var key=inp.dataset.key,c=parseInt(inp.dataset.col,10);
        if(!LB_PERF_DATA[key])LB_PERF_DATA[key]={};
        if(!LB_PERF_DATA[key].cols)LB_PERF_DATA[key].cols=[];
        LB_PERF_DATA[key].cols[c]=inp.value;
      });
    });
  }
  function lbRenderPerformance(){
    var el=document.getElementById('lb-performance-preview');
    el.innerHTML=lbBuildPerformanceHtml(false);
    lbBindPerformanceInputs(el);
  }
  document.getElementById('btn-lbf-build').onclick=lbRenderPerformance;

  // --- لیست دانش‌آموزانِ ثبت‌شده برای پایه‌ی انتخاب‌شده (به‌صورت یک ردیف/کشویی، بدون اشغال فضا) ---
  async function lbRenderPerfStudentList(gradeIdx){
    var sel=document.getElementById('lbf-student-select');
    sel.innerHTML='<option value="">در حال بارگذاری...</option>';
    var list=(await lbLoad('performance:list:'+gradeIdx))||[];
    sel.innerHTML='<option value="">— انتخاب دانش‌آموز —</option>';
    list.forEach(function(s){
      var opt=document.createElement('option');
      opt.value=s.uuid;
      opt.textContent=s.name;
      sel.appendChild(opt);
    });
    if(!list.length){
      var opt2=document.createElement('option');
      opt2.value='';opt2.disabled=true;
      opt2.textContent='هنوز دانش‌آموزی برای این پایه ثبت نشده';
      sel.appendChild(opt2);
    }
  }
  async function lbUpdatePerfListEntry(gradeIdx,uuidStr,name){
    var key='performance:list:'+gradeIdx;
    var list=(await lbLoad(key))||[];
    var idx=list.findIndex(function(s){return s.uuid===uuidStr;});
    if(idx>=0)list[idx].name=name;else list.push({uuid:uuidStr,name:name});
    await lbSave(key,list,true);
  }
  // --- عکس پروفایل دانش‌آموز ---
  var LB_PERF_PHOTO='';
  function lbSetPerfPhoto(dataUrl){
    LB_PERF_PHOTO=dataUrl||'';
    var img=document.getElementById('lbf-photo-preview');
    var removeBtn=document.getElementById('btn-lbf-photo-remove');
    if(LB_PERF_PHOTO){img.src=LB_PERF_PHOTO;img.classList.remove('hidden');removeBtn.classList.remove('hidden');}
    else{img.src='';img.classList.add('hidden');removeBtn.classList.add('hidden');}
  }
  document.getElementById('lbf-photo-input').addEventListener('change',async function(){
    var f=this.files&&this.files[0];this.value='';
    if(!f)return;
    try{
      var dataUrl=await resizeProfilePhoto(f);
      lbSetPerfPhoto(dataUrl);
    }catch(e){toast(e.message);}
  });
  document.getElementById('btn-lbf-photo-remove').onclick=function(){lbSetPerfPhoto('');};
  // --- دانش‌آموز جدید: فرم خالی نشان داده می‌شود تا معلم نام را وارد کند ---
  function lbPerfNew(){
    LB_PERF_CURRENT_UUID=null;
    LB_PERF_DATA={};
    document.getElementById('lbf-student-name').value='';
    document.getElementById('lbf-cols').value=12;
    document.getElementById('lbf-student-select').value='';
    document.getElementById('btn-lbf-delete').classList.add('hidden');
    lbSetPerfPhoto('');
    document.getElementById('lbf-form-wrap').classList.remove('hidden');
    lbRenderPerformance();
  }
  document.getElementById('btn-lbf-new').onclick=lbPerfNew;
  // --- بارگذاری سطح عملکرد یک دانش‌آموز خاص با انتخاب نامش از لیست ---
  async function lbPerfLoadStudent(uuidStr){
    var rec=await lbLoad('performance:student:'+uuidStr);
    if(!rec){toast('اطلاعات این دانش‌آموز پیدا نشد');return;}
    LB_PERF_CURRENT_UUID=uuidStr;
    LB_PERF_DATA=rec.data||{};
    document.getElementById('lbf-student-name').value=rec.name||'';
    document.getElementById('lbf-cols').value=rec.cols||12;
    lbSetPerfPhoto(rec.photo||'');
    if(rec.meta){
      document.getElementById('lbf-school').value=rec.meta.school||'';
      document.getElementById('lbf-teacher').value=rec.meta.teacher||'';
      document.getElementById('lbf-year').value=rec.meta.year||'';
    }
    document.getElementById('btn-lbf-delete').classList.remove('hidden');
    document.getElementById('lbf-form-wrap').classList.remove('hidden');
    lbRenderPerformance();
  }
  document.getElementById('lbf-student-select').addEventListener('change',function(){
    if(this.value)lbPerfLoadStudent(this.value);
    else{document.getElementById('lbf-form-wrap').classList.add('hidden');document.getElementById('btn-lbf-delete').classList.add('hidden');}
  });
  // --- حذف دانش‌آموزِ در حال ویرایش از فهرست سطوح عملکرد ---
  document.getElementById('btn-lbf-delete').onclick=async function(){
    if(!LB_PERF_CURRENT_UUID)return;
    var studentName=document.getElementById('lbf-student-name').value||'این دانش‌آموز';
    if(!confirm('آیا از حذف «'+studentName+'» و تمام سطوح عملکرد ثبت‌شده‌ی او مطمئن هستید؟ این کار قابل بازگشت نیست.'))return;
    var gradeIdx=lbSelectedPerfGradeIdx();
    var ok=await lbSave('performance:student:'+LB_PERF_CURRENT_UUID,null,true);
    if(ok){
      var key='performance:list:'+gradeIdx;
      var list=(await lbLoad(key))||[];
      list=list.filter(function(s){return s.uuid!==LB_PERF_CURRENT_UUID;});
      await lbSave(key,list,true);
      await lbRenderPerfStudentList(gradeIdx);
      document.getElementById('lbf-form-wrap').classList.add('hidden');
      document.getElementById('btn-lbf-delete').classList.add('hidden');
      LB_PERF_CURRENT_UUID=null;
      toast('دانش‌آموز حذف شد ✅');
    }else{
      toast('خطا در حذف اطلاعات');
    }
  };
  // --- ذخیره‌ی سطح عملکرد دانش‌آموزِ در حال ویرایش ---
  document.getElementById('btn-lbf-save').onclick=async function(){
    var name=document.getElementById('lbf-student-name').value.trim();
    if(!name){toast('لطفاً ابتدا نام دانش‌آموز را وارد کنید');return;}
    var gradeIdx=lbSelectedPerfGradeIdx();
    if(!LB_PERF_CURRENT_UUID)LB_PERF_CURRENT_UUID=uid();
    var rec={
      uuid:LB_PERF_CURRENT_UUID,
      name:name,
      grade:gradeIdx,
      cols:lbPerfColsCount(),
      photo:LB_PERF_PHOTO,
      meta:{school:document.getElementById('lbf-school').value,teacher:document.getElementById('lbf-teacher').value,year:document.getElementById('lbf-year').value},
      data:LB_PERF_DATA
    };
    var ok=await lbSave('performance:student:'+LB_PERF_CURRENT_UUID,rec,true);
    if(ok){
      await lbUpdatePerfListEntry(gradeIdx,LB_PERF_CURRENT_UUID,name);
      var sel=document.getElementById('lbf-student-select');
      await lbRenderPerfStudentList(gradeIdx);
      sel.value=LB_PERF_CURRENT_UUID;
      toast('سطح عملکرد «'+name+'» ذخیره شد');
    }else{
      toast('خطا در ذخیره اطلاعات');
    }
  };
  // --- تغییر پایه: لیست دانش‌آموزان به‌روزرسانی می‌شود و فرم تا انتخاب/ساخت جدید مخفی می‌ماند ---
  document.getElementById('lbf-grade-select').addEventListener('change',function(){
    document.getElementById('lbf-form-wrap').classList.add('hidden');
    document.getElementById('btn-lbf-delete').classList.add('hidden');
    LB_PERF_CURRENT_UUID=null;
    lbRenderPerfStudentList(lbSelectedPerfGradeIdx());
  });
  function lbPerformanceExportHtml(){
    var gradeText=document.getElementById('lbf-grade-select').selectedOptions[0].textContent;
    var studentName=document.getElementById('lbf-student-name').value||'';
    var photoHtml=LB_PERF_PHOTO?('<img src="'+LB_PERF_PHOTO+'" style="float:left;width:36px;height:36px;border-radius:50%;object-fit:cover;border:1px solid #94a3b8;margin:0 8px 6px 0">'):'';
    var meta=lbMetaBlock([['نام مدرسه','lbf-school'],['نام آموزگار','lbf-teacher'],['سال تحصیلی','lbf-year'],['نام دانش‌آموز','lbf-student-name']]);
    meta=photoHtml+'<p class="lb-meta"><b>پایه تحصیلی:</b> '+esc(gradeText)+'</p>'+meta+'<div style="clear:both"></div>';
    var table=lbBuildPerformanceHtml(true,lbPerfColsCount());
    var note='<p style="margin-top:14px" class="muted">لازم به ذکر است انتظارات آموزشی تمامی پایه‌ها در جدول شماره ۸ ارائه گردیده. آموزگاران بر پایه بر انتظارات پیش‌بینی شده نسبت به تکمیل جدول اقدام می‌نمایند.</p>';
    return meta+table+note;
  }
  document.getElementById('btn-lb-performance-word').onclick=function(){lbWordExport('جدول شماره ۸: ثبت سطوح عملکرد دانش‌آموز',lbPerformanceExportHtml(),'ثبت-سطوح-عملکرد-دانش-آموز',true);};
  document.getElementById('btn-lb-performance-pdf').onclick=function(){lbPrintExport('جدول شماره ۸: ثبت سطوح عملکرد دانش‌آموز',lbPerformanceExportHtml(),true);};
  document.getElementById('btn-lb-performance-excel').onclick=function(){
    var cols=lbPerfColsCount();
    var studentName=document.getElementById('lbf-student-name').value||'دانش‌آموز';
    var subjects=lbPerfActiveSubjects(lbSelectedPerfGradeIdx());
    lbExcelExport('ثبت-سطوح-عملکرد-'+studentName,function(wb){
      var header=['نام درس','مهم‌ترین انتظارات آموزشی'];
      for(var c=0;c<cols;c++)header.push(String(c+1));
      header.push('توصیف کوتاه موارد ضروری');
      var rows=[header];
      subjects.forEach(function(subj){
        var key=subj.name;
        var saved=LB_PERF_DATA[key]||{};
        var expectVal=(saved.expect!==undefined)?saved.expect:subj.items.join('، ');
        var row=[subj.name,expectVal];
        for(var c2=0;c2<cols;c2++)row.push((saved.cols&&saved.cols[c2])||'');
        row.push(saved.desc||'');
        rows.push(row);
      });
      lbAddExcelSheet(wb,'سطوح عملکرد',rows);
    });
  };


  // ===================== ۵. صورتجلسه شورای آموزشی اولیا =====================
  var LB_COUNCIL_HEADERS=['ردیف','نام و نام خانوادگی','سمت / نقش','امضاء'];
  document.getElementById('btn-lbc-build').onclick=function(){
    var n=parseInt(document.getElementById('lbc-rows').value,10)||10;
    lbRebuildPreserving('lbc-table',LB_COUNCIL_HEADERS,n);
  };
  document.getElementById('btn-lbc-addrow').onclick=function(){lbAddSimpleRow('lbc-table',LB_COUNCIL_HEADERS.length);};
  document.getElementById('btn-lbc-build').click();
  function lbCouncilExportHtml(){
    var meta=lbMetaBlock([['تاریخ برگزاری','lbc-date'],['موضوع جلسه','lbc-topic'],['شماره جلسه','lbc-num'],['ساعت تشکیل','lbc-time']]);
    var summary='<p><b>۱- خلاصه مباحث مطرح شده:</b></p><p style="border:1px solid #ccc;padding:10px;min-height:60px">'+esc(document.getElementById('lbc-summary').value||'')+'</p>';
    var decisions='<p><b>۲- تصمیمات و پیشنهادهای ارائه‌شده:</b></p><p style="border:1px solid #ccc;padding:10px;min-height:60px">'+esc(document.getElementById('lbc-decisions').value||'')+'</p>';
    var rows=lbTableToRows(document.getElementById('lbc-table'));
    var table='<p><b>۳- اسامی اعضای جلسه:</b></p>'+lbRowsToHtmlTable(rows);
    var sign='<p style="margin-top:16px"><b>امضاء و تأیید مدیر مدرسه:</b> .......................</p>';
    return meta+summary+decisions+table+sign;
  }
  document.getElementById('btn-lb-council-word').onclick=function(){lbWordExport('جدول شماره ۱: جلسات شورای آموزشی اولیا',lbCouncilExportHtml(),'صورتجلسه-شورای-آموزشی',false);};
  document.getElementById('btn-lb-council-pdf').onclick=function(){lbPrintExport('جدول شماره ۱: جلسات شورای آموزشی اولیا',lbCouncilExportHtml(),false);};
  document.getElementById('btn-lb-council-excel').onclick=function(){
    lbExcelExport('صورتجلسه-شورای-آموزشی',function(wb){
      var ws=wb.addWorksheet('صورتجلسه',{views:[{rightToLeft:true}]});
      ws.addRow(['تاریخ برگزاری',document.getElementById('lbc-date').value]);
      ws.addRow(['موضوع جلسه',document.getElementById('lbc-topic').value]);
      ws.addRow(['شماره جلسه',document.getElementById('lbc-num').value]);
      ws.addRow(['ساعت تشکیل',document.getElementById('lbc-time').value]);
      ws.addRow([]);
      ws.addRow(['خلاصه مباحث مطرح شده',document.getElementById('lbc-summary').value]);
      ws.addRow(['تصمیمات و پیشنهادها',document.getElementById('lbc-decisions').value]);
      ws.addRow([]);
      lbTableToRows(document.getElementById('lbc-table')).forEach(function(r){ws.addRow(r);});
      ws.columns.forEach(function(c){c.width=28;});
    });
  };
  var LB_COUNCIL_LOADED=false;
  async function lbLoadCouncilIfNeeded(){
    if(LB_COUNCIL_LOADED)return;
    LB_COUNCIL_LOADED=true;
    var saved=await lbLoad('council');
    if(!saved)return;
    if(saved.meta){
      document.getElementById('lbc-date').value=saved.meta.date||'';
      document.getElementById('lbc-topic').value=saved.meta.topic||'';
      document.getElementById('lbc-num').value=saved.meta.num||'';
      document.getElementById('lbc-time').value=saved.meta.time||'';
    }
    document.getElementById('lbc-summary').value=saved.summary||'';
    document.getElementById('lbc-decisions').value=saved.decisions||'';
    if(saved.rowCount){document.getElementById('lbc-rows').value=saved.rowCount;document.getElementById('btn-lbc-build').click();}
    if(saved.rows)lbFillTableRows('lbc-table',saved.rows);
  }
  document.getElementById('btn-lbc-save').onclick=function(){
    lbSave('council',{
      meta:{date:document.getElementById('lbc-date').value,topic:document.getElementById('lbc-topic').value,num:document.getElementById('lbc-num').value,time:document.getElementById('lbc-time').value},
      summary:document.getElementById('lbc-summary').value,
      decisions:document.getElementById('lbc-decisions').value,
      rowCount:parseInt(document.getElementById('lbc-rows').value,10)||10,
      rows:lbTableToRows(document.getElementById('lbc-table')).slice(1)
    });
  };

  // ===================== ۶. جلسات فردی با اولیا =====================
  var LB_MEET_HEADERS=['ردیف','نام و نام خانوادگی ولی','نسبت با دانش‌آموز','تاریخ دیدار','موضوع دیدار','نتایج (تصمیمات، راهکارها، پیگیری)'];
  document.getElementById('btn-lbm-build').onclick=function(){
    var n=parseInt(document.getElementById('lbm-rows').value,10)||15;
    lbRebuildPreserving('lbm-table',LB_MEET_HEADERS,n);
  };
  document.getElementById('btn-lbm-addrow').onclick=function(){lbAddSimpleRow('lbm-table',LB_MEET_HEADERS.length);};
  document.getElementById('btn-lbm-build').click();
  function lbMeetingsExportHtml(){
    var meta=lbMetaBlock([['نام مدرسه','lbm-school'],['نام آموزگار','lbm-teacher'],['پایه تحصیلی','lbm-grade'],['سال تحصیلی','lbm-year']]);
    var rows=lbTableToRows(document.getElementById('lbm-table'));
    return meta+lbRowsToHtmlTable(rows)+'<p style="margin-top:14px"><b>ادامه جلسات فردی با اولیا</b></p>';
  }
  document.getElementById('btn-lb-meetings-word').onclick=function(){lbWordExport('جدول ۱۰ - جلسات فردی با اولیا',lbMeetingsExportHtml(),'جلسات-فردی-با-اولیا',true);};
  document.getElementById('btn-lb-meetings-pdf').onclick=function(){lbPrintExport('جدول ۱۰ - جلسات فردی با اولیا',lbMeetingsExportHtml(),true);};
  document.getElementById('btn-lb-meetings-excel').onclick=function(){
    lbExcelExport('جلسات-فردی-با-اولیا',function(wb){
      lbAddExcelSheet(wb,'جلسات فردی',lbTableToRows(document.getElementById('lbm-table')));
    });
  };
  var LB_MEETINGS_LOADED=false;
  async function lbLoadMeetingsIfNeeded(){
    if(LB_MEETINGS_LOADED)return;
    LB_MEETINGS_LOADED=true;
    var saved=await lbLoad('meetings');
    if(!saved)return;
    if(saved.meta){
      document.getElementById('lbm-school').value=saved.meta.school||'';
      document.getElementById('lbm-teacher').value=saved.meta.teacher||'';
      document.getElementById('lbm-grade').value=saved.meta.grade||'';
      document.getElementById('lbm-year').value=saved.meta.year||'';
    }
    if(saved.rowCount){document.getElementById('lbm-rows').value=saved.rowCount;document.getElementById('btn-lbm-build').click();}
    if(saved.rows)lbFillTableRows('lbm-table',saved.rows);
  }
  document.getElementById('btn-lbm-save').onclick=function(){
    lbSave('meetings',{
      meta:{school:document.getElementById('lbm-school').value,teacher:document.getElementById('lbm-teacher').value,grade:document.getElementById('lbm-grade').value,year:document.getElementById('lbm-year').value},
      rowCount:parseInt(document.getElementById('lbm-rows').value,10)||15,
      rows:lbTableToRows(document.getElementById('lbm-table')).slice(1)
    });
  };

  // ===================== ۷. برنامه درسی هفتگی (ویژه چندپایه) - جدول ۱-۳-۱ =====================
  var LB_WEEKLY_DAYS=['شنبه','یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه'];
  var LB_WEEKLY_GRADE_NAMES=['اول','دوم','سوم','چهارم','پنجم','ششم'];
  var LB_WEEKLY_DATA={}; // key: 'dayIdx-gradeIdx-sessionIdx' -> مقدار سلول (gradeIdx همیشه بر اساس شماره‌ی واقعی پایه ۰ تا ۵ است، حتی اگر آن پایه فعلاً انتخاب نشده باشد)
  function lbSelectedWeeklyGrades(){
    var out=[];
    document.querySelectorAll('.lbw-grade-chk').forEach(function(chk,idx){
      if(chk.checked)out.push(idx);
    });
    return out;
  }
  function lbBuildWeeklyHtml(forExport){
    var grades=lbSelectedWeeklyGrades();
    if(!grades.length)grades=[0,1,2,3,4,5];
    var h='<p style="font-weight:700;margin-bottom:6px">برنامه درسی چندپایه</p>';
    h+='<table class="lb-table lb-table-tight" style="width:100%"><thead><tr><th>روز</th><th>پایه</th><th>زنگ اول</th><th>زنگ دوم</th><th>زنگ سوم</th><th>زنگ چهارم</th><th>زنگ پنجم</th></tr></thead><tbody>';
    LB_WEEKLY_DAYS.forEach(function(day,dIdx){
      grades.forEach(function(gIdx,i){
        h+='<tr>';
        if(i===0)h+='<td rowspan="'+grades.length+'" style="font-weight:700;background:#f1f5f9">'+esc(day)+'</td>';
        h+='<td style="font-weight:700">'+LB_WEEKLY_GRADE_NAMES[gIdx]+'</td>';
        for(var s=0;s<5;s++){
          var key=dIdx+'-'+gIdx+'-'+s;
          var v=LB_WEEKLY_DATA[key]||'';
          h+=forExport?'<td>'+esc(v)+'</td>':'<td><input type="text" class="lb-weekly-cell" data-key="'+key+'" value="'+esc(v)+'"></td>';
        }
        h+='</tr>';
      });
    });
    h+='</tbody></table>';
    return h;
  }
  function lbBindWeeklyInputs(el){
    el.querySelectorAll('.lb-weekly-cell').forEach(function(inp){
      inp.addEventListener('input',function(){LB_WEEKLY_DATA[inp.dataset.key]=inp.value;});
    });
  }
  function lbRenderWeekly(){
    var el=document.getElementById('lb-weekly-preview');
    el.innerHTML=lbBuildWeeklyHtml(false);
    lbBindWeeklyInputs(el);
  }
  document.getElementById('btn-lbw-build').onclick=lbRenderWeekly;
  var LB_WEEKLY_LOADED=false;
  async function lbLoadWeeklyIfNeeded(){
    if(LB_WEEKLY_LOADED){lbRenderWeekly();return;}
    LB_WEEKLY_LOADED=true;
    var saved=await lbLoad('weekly');
    if(saved){
      document.getElementById('lbw-school').value=saved.school||'';
      document.getElementById('lbw-teacher').value=saved.teacher||'';
      document.getElementById('lbw-class').value=saved.className||'';
      if(saved.data)LB_WEEKLY_DATA=saved.data;
      if(saved.grades&&saved.grades.length){
        document.querySelectorAll('.lbw-grade-chk').forEach(function(chk,idx){
          chk.checked=saved.grades.indexOf(idx)>=0;
        });
      }
    }
    lbRenderWeekly();
  }
  document.getElementById('btn-lbw-save').onclick=function(){
    lbSave('weekly',{
      school:document.getElementById('lbw-school').value,
      teacher:document.getElementById('lbw-teacher').value,
      className:document.getElementById('lbw-class').value,
      grades:lbSelectedWeeklyGrades(),
      data:LB_WEEKLY_DATA
    });
  };
  function lbWeeklySignatureFooterHtml(){
    return '<table style="width:100%;border:none;margin-top:46px"><tr>'
      +'<td style="border:none;width:50%;text-align:center;vertical-align:top;padding:0 10px">نام مدیر مدرسه: .......................................<br><br><br>مهر و امضا</td>'
      +'<td style="border:none;width:50%;text-align:center;vertical-align:top;padding:0 10px">نام کارشناس آموزش منطقه: .......................................<br><br><br>مهر و امضا</td>'
      +'</tr></table>';
  }
  function lbWeeklyExportHtml(){
    var meta='<p class="lb-meta"><b>نام مدرسه:</b> '+esc(document.getElementById('lbw-school').value)+'&nbsp;&nbsp;&nbsp;&nbsp;<b>نام آموزگار:</b> '+esc(document.getElementById('lbw-teacher').value)+'&nbsp;&nbsp;&nbsp;&nbsp;<b>کلاس:</b> '+esc(document.getElementById('lbw-class').value)+'</p>';
    return meta+lbBuildWeeklyHtml(true)+lbWeeklySignatureFooterHtml();
  }
  document.getElementById('btn-lb-weekly-word').onclick=function(){lbWordExport('جدول ۱-۳-۱ ـ برنامه درسی هفتگی (ویژه چندپایه)',lbWeeklyExportHtml(),'برنامه-درسی-هفتگی',false);};
  document.getElementById('btn-lb-weekly-pdf').onclick=function(){lbPrintExport('جدول ۱-۳-۱ ـ برنامه درسی هفتگی (ویژه چندپایه)',lbWeeklyExportHtml(),false);};
  document.getElementById('btn-lb-weekly-excel').onclick=function(){
    var grades=lbSelectedWeeklyGrades();
    if(!grades.length)grades=[0,1,2,3,4,5];
    lbExcelExport('برنامه-درسی-هفتگی',function(wb){
      var rows=[['روز','پایه','زنگ اول','زنگ دوم','زنگ سوم','زنگ چهارم','زنگ پنجم']];
      LB_WEEKLY_DAYS.forEach(function(day,dIdx){
        grades.forEach(function(gIdx,i){
          var row=[i===0?day:'',LB_WEEKLY_GRADE_NAMES[gIdx]];
          for(var s=0;s<5;s++)row.push(LB_WEEKLY_DATA[dIdx+'-'+gIdx+'-'+s]||'');
          rows.push(row);
        });
      });
      lbAddExcelSheet(wb,'برنامه هفتگی',rows);
    });
  };

  // ===================== ۸. برنامه درسی هفتگی (کلاس تک‌پایه) - جدول ۳ =====================
  var LB_WEEKLY2_DAYS=['شنبه','یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه'];
  var LB_WEEKLY2_SESSIONS=['زنگ اول','زنگ دوم','سوم','چهارم','پنجم'];
  var LB_WEEKLY2_DATA={}; // key: 'dayIdx-sessionIdx'
  function lbWeekly2DiagCellHtml(forExport){
    if(forExport){
      // استایل inline کامل تا در فایل Word/چاپ هم (بدون وابستگی به استایل صفحه) درست دیده شود
      return '<th style="position:relative;padding:0;height:44px;min-width:70px;'
        +'background:linear-gradient(to top left, transparent calc(50% - 1px), #94a3b8 calc(50% - 1px), #94a3b8 calc(50% + 1px), transparent calc(50% + 1px))">'
        +'<span style="position:absolute;top:2px;left:6px;font-size:10px;font-weight:700">زنگ</span>'
        +'<span style="position:absolute;bottom:2px;right:6px;font-size:10px;font-weight:700">روز</span>'
        +'</th>';
    }
    return '<th class="lb-diag-cell"><span class="lb-diag-top">زنگ</span><span class="lb-diag-bottom">روز</span></th>';
  }
  function lbBuildWeekly2Html(forExport){
    var h='<table class="lb-table lb-table-tight" style="width:100%"><thead><tr>';
    h+=lbWeekly2DiagCellHtml(forExport);
    LB_WEEKLY2_SESSIONS.forEach(function(s){h+='<th>'+esc(s)+'</th>';});
    h+='</tr></thead><tbody>';
    LB_WEEKLY2_DAYS.forEach(function(day,dIdx){
      h+='<tr><td style="font-weight:700;background:#f1f5f9">'+esc(day)+'</td>';
      LB_WEEKLY2_SESSIONS.forEach(function(s,sIdx){
        var key=dIdx+'-'+sIdx;
        var v=LB_WEEKLY2_DATA[key]||'';
        h+=forExport?'<td>'+esc(v)+'</td>':'<td><input type="text" class="lb-weekly2-cell" data-key="'+key+'" value="'+esc(v)+'"></td>';
      });
      h+='</tr>';
    });
    h+='</tbody></table>';
    return h;
  }
  function lbBindWeekly2Inputs(el){
    el.querySelectorAll('.lb-weekly2-cell').forEach(function(inp){
      inp.addEventListener('input',function(){LB_WEEKLY2_DATA[inp.dataset.key]=inp.value;});
    });
  }
  function lbRenderWeekly2(){
    var el=document.getElementById('lb-weekly2-preview');
    el.innerHTML=lbBuildWeekly2Html(false);
    lbBindWeekly2Inputs(el);
  }
  var LB_WEEKLY2_LOADED=false;
  async function lbLoadWeekly2IfNeeded(){
    if(LB_WEEKLY2_LOADED){lbRenderWeekly2();return;}
    LB_WEEKLY2_LOADED=true;
    var saved=await lbLoad('weekly2');
    if(saved){
      document.getElementById('lbw2-school').value=saved.school||'';
      document.getElementById('lbw2-teacher').value=saved.teacher||'';
      document.getElementById('lbw2-grade').value=saved.grade||'';
      document.getElementById('lbw2-class').value=saved.className||'';
      if(saved.data)LB_WEEKLY2_DATA=saved.data;
    }
    lbRenderWeekly2();
  }
  document.getElementById('btn-lbw2-save').onclick=function(){
    lbSave('weekly2',{school:document.getElementById('lbw2-school').value,teacher:document.getElementById('lbw2-teacher').value,grade:document.getElementById('lbw2-grade').value,className:document.getElementById('lbw2-class').value,data:LB_WEEKLY2_DATA});
  };
  function lbWeekly2ExportHtml(){
    var meta='<p class="lb-meta"><b>نام مدرسه:</b> '+esc(document.getElementById('lbw2-school').value)+' &nbsp;&nbsp;&nbsp; <b>نام آموزگار:</b> '+esc(document.getElementById('lbw2-teacher').value)+' &nbsp;&nbsp;&nbsp; <b>پایه:</b> '+esc(document.getElementById('lbw2-grade').value)+' &nbsp;&nbsp;&nbsp; <b>کلاس:</b> '+esc(document.getElementById('lbw2-class').value)+'</p>';
    return meta+lbBuildWeekly2Html(true);
  }
  document.getElementById('btn-lb-weekly2-word').onclick=function(){lbWordExport('جدول ۳- برنامه درسی هفتگی (کلاس تک پایه)',lbWeekly2ExportHtml(),'برنامه-درسی-هفتگی-تک-پایه',false);};
  document.getElementById('btn-lb-weekly2-pdf').onclick=function(){lbPrintExport('جدول ۳- برنامه درسی هفتگی (کلاس تک پایه)',lbWeekly2ExportHtml(),false);};
  document.getElementById('btn-lb-weekly2-excel').onclick=function(){
    lbExcelExport('برنامه-درسی-هفتگی-تک-پایه',function(wb){
      var rows=[['روز'].concat(LB_WEEKLY2_SESSIONS)];
      LB_WEEKLY2_DAYS.forEach(function(day,dIdx){
        var row=[day];
        LB_WEEKLY2_SESSIONS.forEach(function(s,sIdx){row.push(LB_WEEKLY2_DATA[dIdx+'-'+sIdx]||'');});
        rows.push(row);
      });
      lbAddExcelSheet(wb,'برنامه هفتگی تک‌پایه',rows);
    });
  };

  // ===================== ۹. اطلاعات پرسنلی همکاران مدرسه =====================
  var LB_STAFF_HEADERS=['ردیف','کد پرسنلی','نام و نام خانوادگی','سمت','سابقه','مدرک','نوع استخدام','پایه تدریس'];
  var LB_STAFF_COL_WIDTHS=['5%','10%','20%','12%','8%','10%','12%','23%'];
  function lbBuildStaffTableHtml(rowCount){
    var h='<colgroup>'+LB_STAFF_COL_WIDTHS.map(function(w){return '<col style="width:'+w+'">';}).join('')+'</colgroup>';
    h+='<thead><tr>'+LB_STAFF_HEADERS.map(function(hd){return '<th>'+esc(hd)+'</th>';}).join('')+'</tr></thead><tbody>';
    for(var r=1;r<=rowCount;r++){
      h+='<tr><td>'+toFaDigits(r)+'</td>';
      for(var c=1;c<LB_STAFF_HEADERS.length;c++)h+='<td><input type="text"></td>';
      h+='</tr>';
    }
    h+='</tbody>';
    return h;
  }
  function lbRebuildStaffPreserving(rowCount){
    var tableEl=document.getElementById('lbs-table');
    var oldRows=tableEl.querySelector('tbody')?lbTableToRows(tableEl).slice(1):[];
    tableEl.innerHTML=lbBuildStaffTableHtml(rowCount);
    var trs=tableEl.querySelectorAll('tbody tr');
    trs.forEach(function(tr,rIdx){
      var oldRow=oldRows[rIdx];
      if(!oldRow)return;
      var tds=tr.querySelectorAll('td');
      tds.forEach(function(td,cIdx){
        if(cIdx===0)return;
        var inp=td.querySelector('input');
        if(inp && oldRow[cIdx]!==undefined)inp.value=oldRow[cIdx];
      });
    });
  }
  document.getElementById('btn-lbs-build').onclick=function(){
    var n=parseInt(document.getElementById('lbs-rows').value,10)||15;
    lbRebuildStaffPreserving(n);
  };
  document.getElementById('btn-lbs-addrow').onclick=function(){
    var tbody=document.querySelector('#lbs-table tbody');
    var rowNum=tbody.children.length+1;
    var tr=document.createElement('tr');
    var html='<td>'+toFaDigits(rowNum)+'</td>';
    for(var c=1;c<LB_STAFF_HEADERS.length;c++)html+='<td><input type="text"></td>';
    tr.innerHTML=html;
    tbody.appendChild(tr);
  };
  document.getElementById('btn-lbs-build').click();
  var LB_STAFF_LOADED=false;
  async function lbLoadStaffIfNeeded(){
    if(LB_STAFF_LOADED)return;
    LB_STAFF_LOADED=true;
    var saved=await lbLoad('staff');
    if(!saved)return;
    document.getElementById('lbs-year').value=saved.year||'';
    if(saved.rowCount){document.getElementById('lbs-rows').value=saved.rowCount;document.getElementById('btn-lbs-build').click();}
    if(saved.rows)lbFillTableRows('lbs-table',saved.rows);
  }
  document.getElementById('btn-lbs-save').onclick=function(){
    lbSave('staff',{
      year:document.getElementById('lbs-year').value,
      rowCount:parseInt(document.getElementById('lbs-rows').value,10)||15,
      rows:lbTableToRows(document.getElementById('lbs-table')).slice(1)
    });
  };
  function lbStaffExportHtml(){
    var year=document.getElementById('lbs-year').value;
    var head='<table style="width:100%;border:none;margin-bottom:10px"><tr>'
      +'<td style="border:none;text-align:right;font-weight:700;font-size:15px">اطلاعات پرسنلی همکاران مدرسه</td>'
      +'<td style="border:none;text-align:left;font-weight:700">سال تحصیلی: '+esc(year)+'</td>'
      +'</tr></table>';
    var rows=lbTableToRows(document.getElementById('lbs-table'));
    var table='<table class="lb-table-zebra">'+lbBuildStaffTableHtml(rows.length-1)+'</table>';
    // مقداردهی سلول‌های خروجی از روی جدول زنده (چون lbBuildStaffTableHtml فقط ساختار خالی می‌سازد)
    var tmp=document.createElement('div');
    tmp.innerHTML=table;
    var trs=tmp.querySelectorAll('tbody tr');
    rows.slice(1).forEach(function(r,rIdx){
      var tds=trs[rIdx]?trs[rIdx].querySelectorAll('td'):[];
      tds.forEach(function(td,cIdx){
        if(cIdx===0)return;
        var inp=td.querySelector('input');
        if(inp)td.innerHTML=esc(r[cIdx]||'');
      });
    });
    return head+tmp.innerHTML;
  }
  document.getElementById('btn-lb-staff-word').onclick=function(){lbWordExport('اطلاعات پرسنلی همکاران مدرسه',lbStaffExportHtml(),'اطلاعات-پرسنلی-همکاران',true);};
  document.getElementById('btn-lb-staff-pdf').onclick=function(){lbPrintExport('اطلاعات پرسنلی همکاران مدرسه',lbStaffExportHtml(),true);};
  document.getElementById('btn-lb-staff-excel').onclick=function(){
    lbExcelExport('اطلاعات-پرسنلی-همکاران',function(wb){
      lbAddExcelSheet(wb,'پرسنل',lbTableToRows(document.getElementById('lbs-table')));
    });
  };
  // ===================== پایان دفتر مدیریت کلاسی =====================

  checkAuth();
  `;
}
