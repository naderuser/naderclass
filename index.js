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
  
  const footer = `<div class="footer"><p>امضای مدیر: ___________________</p><p>تاریخ: ___________________</p></div>`;
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
      return wordResponse(examWord(meta, questions), "برگه-آزمون.doc");
    }

    if (path === "/api/teacher/ai/chat" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const messages = body.messages || [];
      const apiKey = env.GROQ_API_KEY;
      if (!apiKey) return json({ error: "کلید GROQ_API_KEY تنظیم نشده" }, 500);
      try {
        const aiRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            messages: [{ role: "system", content: "You are a helpful assistant for Iranian teachers. Follow the system/user instructions provided about which language to respond in." }, ...messages.slice(-10)],
            max_tokens: 1024
          })
        });
        if (!aiRes.ok) {
          const errText = await aiRes.text();
          return json({ error: "Groq: " + errText }, aiRes.status);
        }
        const aiData = await aiRes.json();
        return json({ ok: true, content: aiData.choices?.[0]?.message?.content || "" });
      } catch (e) {
        return json({ error: "Error: " + e.message }, 500);
      }
    }
  }

  return json({ ok: false, error: "مسیر یافت نشد" }, 404);
}

/* ------------------------- خروجی Word ------------------------- */

function wordResponse(bodyHtml, filename) {
  const doc =
    `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">` +
    `<head><meta charset="utf-8">` +
    `<style>
      @page { size: A4; margin: 2cm; }
      body { font-family: 'B Nazanin','Tahoma',sans-serif; direction: rtl; font-size: 13pt; }
      .hdr { text-align:center; border-bottom: 2px solid #000; padding-bottom:8px; margin-bottom:14px; }
      .hdr h1 { font-size: 15pt; margin: 2px 0; }
      .hdr h2 { font-size: 12pt; margin: 2px 0; font-weight: normal; }
      .hdr h3 { font-size: 12pt; margin: 2px 0; font-weight: normal; }
      .meta-table { width:100%; border-collapse: collapse; margin-bottom: 14px; }
      .meta-table td { border: 1px solid #000; padding: 6px 8px; }
      table.q { width:100%; border-collapse: collapse; margin-bottom: 10px; }
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
  .lb-pacing-table{width:max-content;min-width:100%;border-collapse:collapse;font-size:11px;margin-bottom:22px}
  .lb-pacing-table th,.lb-pacing-table td{border:1px solid #94a3b8;padding:4px 6px;text-align:center}
  .lb-pacing-table th{background:#dbeafe}
  [data-theme="dark"] .lb-pacing-table th{background:#1e3a5f}
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
  .schedule-table-wrap{overflow-x:auto;border-radius:18px;background:#fff;margin-bottom:16px;box-shadow:0 10px 30px rgba(15,23,42,.10),0 2px 8px rgba(15,23,42,.06);border:1px solid #e2e8f0}
  [data-theme="dark"] .schedule-table-wrap{background:#1e293b;border-color:#334155;box-shadow:0 10px 30px rgba(0,0,0,.35)}
  .schedule-table{width:100%;border-collapse:separate;border-spacing:0}
  .schedule-table th{padding:16px 10px;font-weight:800;text-align:center;font-size:14px;letter-spacing:.2px;border-bottom:2px solid #e2e8f0}
  [data-theme="dark"] .schedule-table th{border-color:#334155}
  .schedule-table th.sch-corner{background:linear-gradient(135deg,#1e293b,#334155);color:#fff;border-radius:18px 0 0 0}
  [data-theme="dark"] .schedule-table th.sch-corner{background:linear-gradient(135deg,#0f172a,#1e293b)}
  .schedule-table th.sch-period{background:#f8fafc;color:#334155;border-left:1px solid #e2e8f0}
  [data-theme="dark"] .schedule-table th.sch-period{background:#0f172a;color:#e2e8f0;border-color:#334155}
  .schedule-table th.sch-period:last-child{border-radius:0 18px 0 0;border-left:none}
  .schedule-table td{padding:12px 8px;text-align:center;font-weight:600;color:#1e293b;border-bottom:1px solid #eef2f6;border-left:1px solid #eef2f6}
  [data-theme="dark"] .schedule-table td{color:#f1f5f9;border-color:#2d3b4e}
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
  
  .ai-chat-container{background:linear-gradient(180deg,#f8fafc,#fff);border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;display:flex;flex-direction:column;height:550px}
  [data-theme="dark"] .ai-chat-container{background:#1e293b;border-color:#475569}
  .ai-header{display:flex;align-items:center;gap:12px;padding:16px 20px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}
  .ai-avatar{width:48px;height:48px;background:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:24px;box-shadow:0 4px 12px rgba(0,0,0,.2)}
  .ai-title{flex:1}
  .ai-title h3{margin:0;font-size:16px;font-weight:700}
  .ai-status{font-size:12px;opacity:.8}
  .ai-mode-select select{padding:8px 12px;border-radius:8px;border:none;background:#fff;color:#333;font-size:13px;font-weight:600;cursor:pointer}
  .ai-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
  .ai-message{display:flex;gap:10px;max-width:85%}
  .ai-message.user{flex-direction:row-reverse;align-self:flex-end}
  .ai-message.ai{align-self:flex-start}
  .ai-message-avatar{width:36px;height:36px;background:#e0e7ff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
  .ai-message.user .ai-message-avatar{background:#dbeafe;order:1}
  .ai-message-content{background:#fff;border-radius:16px;padding:12px 16px;box-shadow:0 2px 8px rgba(0,0,0,.08);border:1px solid #e2e8f0}
  [data-theme="dark"] .ai-message-content{background:#1e293b;border-color:#475569;color:#e2e8f0}
  .ai-message.user .ai-message-content{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border-color:transparent}
  .ai-message-text{line-height:1.7;font-size:14px;white-space:pre-wrap}
  .ai-typing-dots{display:flex;gap:4px;padding:4px 0}
  .ai-typing-dots span{width:8px;height:8px;background:#667eea;border-radius:50%;animation:typingBounce 1.4s infinite ease-in-out}
  .ai-typing-dots span:nth-child(1){animation-delay:-.32s}
  .ai-typing-dots span:nth-child(2){animation-delay:-.16s}
  @keyframes typingBounce{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}
  .ai-quick-actions{display:flex;gap:8px;padding:12px 16px;flex-wrap:wrap;border-top:1px solid #e2e8f0;background:#fafbfc}
  [data-theme="dark"] .ai-quick-actions{background:#1e293b;border-color:#475569}
  .quick-action-btn{padding:8px 14px;background:#fff;border:2px solid #e2e8f0;border-radius:999px;font-size:13px;cursor:pointer;transition:all .2s;font-weight:500}
  [data-theme="dark"] .quick-action-btn{background:#1e293b;color:#e2e8f0}
  .quick-action-btn:hover{background:#667eea;color:#fff;border-color:#667eea}
  .ai-input-area{display:flex;gap:10px;padding:16px;border-top:1px solid #e2e8f0;background:#fff;align-items:flex-end}
  [data-theme="dark"] .ai-input-area{background:#1e293b;border-color:#475569}
  .ai-input-area textarea{flex:1;padding:12px 16px;border:2px solid #e2e8f0;border-radius:12px;resize:none;font-size:14px;line-height:1.5;max-height:120px;font-family:inherit}
  .ai-input-area textarea:focus{border-color:#667eea;outline:none}
  .ai-send-btn{width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;padding:0}
  
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

    <!-- مرحله ۱: اطلاعات و سوال امنیتی -->
    <div class="card hidden" id="step-info">
      <h3>📝 اطلاعات دانش‌آموز</h3>
      <div class="row">
        <div><label>نام و نام خانوادگی *</label><input id="f-name" autocomplete="off"></div>
        <div><label>نام پدر *</label><input id="f-father" autocomplete="off"></div>
      </div>
      <div class="row">
        <div><label>کد ملی *</label><input id="f-nid" inputmode="numeric" autocomplete="off"></div>
        <div><label>نام درس *</label><input id="f-course" autocomplete="off"></div>
        <div><label>تاریخ آزمون *</label><input id="f-date" autocomplete="off" placeholder="مثال: 1404/01/15"></div>
      </div>
      <label>سوال امنیتی: <span id="sec-q"></span> *</label><input id="f-sec" inputmode="numeric" autocomplete="off">
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
    const a = Math.floor(Math.random()*8)+2, b = Math.floor(Math.random()*8)+2;

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
        renderResult(d.result);
      } else {
        document.getElementById('step-info').classList.remove('hidden');
        try {
          const now = new Date();
          document.getElementById('f-date').value = now.toLocaleDateString('fa-IR', {year:'numeric', month:'2-digit', day:'2-digit'}).replace(/\\//g, '/');
        } catch(e) {}
      }
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
      if(!DATA.questions.length){box.innerHTML='<p class="muted">هنوز سوالی توسط معلم طراحی نشده است.</p>';return;}
      box.innerHTML = DATA.questions.map((q,i)=>{
        let body='';
        if(q.type==='multiple'){
          body=(q.options||[]).map((o,oi)=>'<div class="opt-row"><label style="font-weight:400;margin:0"><input type="radio" name="q_'+q.id+'" value="'+oi+'" style="width:auto;margin-left:6px"> '+['الف','ب','ج','د'][oi]+') '+esc(o)+'</label></div>').join('');
        }else if(q.type==='truefalse'){
          body='<div class="opt-row"><label style="font-weight:400;margin:0"><input type="radio" name="q_'+q.id+'" value="true" style="width:auto;margin-left:6px"> ✅ صحیح</label>&nbsp;&nbsp;<label style="font-weight:400;margin:0"><input type="radio" name="q_'+q.id+'" value="false" style="width:auto;margin-left:6px"> ❌ غلط</label></div>';
        }else if(q.type==='short'){
          body='<input type="text" data-q="'+q.id+'" autocomplete="off" placeholder="پاسخ خود را وارد کنید...">';
        }else{
          body='<textarea data-q="'+q.id+'" placeholder="پاسخ خود را بنویسید..."></textarea>';
        }
        const img=q.image?'<img src="'+q.image+'" class="imgprev" style="max-width:'+(q.imageWidth||320)+'px;width:100%">':'';
        const weightInfo = q.weight ? \`<span style="font-size:11px;color:#64748b;margin-right:8px">(وزن: \${q.weight})</span>\` : '';
        return '<div class="q-block"><div class="qhead"><b>'+(i+1)+'. '+qHtml(q)+'</b><span class="badge">'+typeLabel(q.type)+weightInfo+'</span></div>'+img+body+'</div>';
      }).join('');
    }

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
          body:JSON.stringify({...window._student, answers})
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
      const course=document.getElementById('f-course').value.trim();
      const date=document.getElementById('f-date').value.trim();
      const sec=document.getElementById('f-sec').value.trim();
      const err=document.getElementById('info-err');
      if(!name||!father||!nid||!course||!date){err.textContent='لطفاً همه فیلدها را پر کنید.';return;}
      if(parseInt(sec,10)!==a+b){err.textContent='پاسخ سوال امنیتی اشتباه است.';return;}
      err.textContent='';
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

    document.getElementById('sec-q').textContent = a + ' + ' + b + ' = ؟';
    try{ 
      const now = new Date();
      document.getElementById('f-date').value = now.toLocaleDateString('fa-IR', {year:'numeric', month:'2-digit', day:'2-digit'}).replace(/\\//g, '/');
    }catch(e){}
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
        <div class="tab active" data-tab="students">👨‍🎓 دانش‌آموزان</div>
        <div class="tab" data-tab="questions">📝 طراحی سوالات</div>
        <div class="tab" data-tab="answers">✅ تصحیح و پاسخنامه‌ها</div>
        <div class="tab" data-tab="schedule">📅 برنامه هفتگی</div>
        <div class="tab" data-tab="tables">📊 جدول‌ساز</div>
        <div class="tab" data-tab="scan">📷 اسکنر</div>
        <div class="tab" data-tab="resize">🗜️ کاهش حجم</div>
        <div class="tab" data-tab="crop">✂️ برش عکس</div>
        <div class="tab" data-tab="pdf2img">📄 PDF به عکس</div>
        <div class="tab" data-tab="translate">🌐 ترجمه</div>
        <div class="tab" data-tab="ai">🤖 هوش مصنوعی</div>
        <div class="tab" data-tab="classroom">🖥️ کلاس آنلاین</div>
        <div class="tab" data-tab="logbook">📔 دفتر مدیریت کلاسی</div>
        <div class="tab" data-tab="settings">⚙️ تنظیمات</div>
        <div style="flex:1"></div>
        <div class="tab" id="btn-logout" style="background:#fee2e2;color:#991b1b">🚪 خروج</div>
      </div>

      <div class="card tab-content" id="tab-students">
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

      <div class="card tab-content hidden" id="tab-questions">
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

      <div class="card tab-content hidden" id="tab-answers">
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
        <button class="btn gray sm" id="btn-refresh-ans">🔄 به‌روزرسانی</button>
        <div id="answers-list"></div>
      </div>

      <div class="card tab-content hidden" id="tab-schedule">
        <h3>📅 برنامه هفتگی</h3>
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
        <div class="schedule-table-wrap">
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

      <div class="card tab-content hidden" id="tab-tables">
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
          <button class="btn sec" id="btn-word-table">📄 دانلود Word</button>
          <button class="btn gray" id="btn-excel-table">📊 دانلود Excel واقعی (xlsx)</button>
        </div>
      </div>

      <div class="card tab-content hidden" id="tab-scan">
        <h3>📷 اسکنر حرفه‌ای (مشابه CamScanner)</h3>
        <p class="muted">عکس‌های خود را با کیفیت بالا اسکن کنید</p>
        <div class="upload-zone" id="scan-drop-zone">
          <input type="file" accept="image/*" id="scan-file" class="hidden">
          <div class="upload-icon">📷</div>
          <p>عکس را اینجا رها کنید یا کلیک کنید</p>
          <span class="muted">فرمت‌های مجاز: JPG, PNG, WEBP</span>
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
            <button class="btn secondary" id="btn-rotate-l">↶ چرخش چپ</button>
            <button class="btn secondary" id="btn-rotate-r">↷ چرخش راست</button>
            <button class="btn primary" id="btn-dl-img">💾 دانلود عکس</button>
            <button class="btn success" id="btn-dl-pdf">📄 دانلود PDF</button>
            <button class="btn secondary" id="btn-reset-scan">🔄 بازنشانی</button>
            <button class="btn danger" id="btn-remove-scan">🗑️ حذف عکس</button>
          </div>
        </div>
      </div>

      <div class="card tab-content hidden" id="tab-resize">
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

      <div class="card tab-content hidden" id="tab-crop">
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

      <div class="card tab-content hidden" id="tab-pdf2img">
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
            <div class="pdf-option-group" style="margin-top:12px"><label>فرمت خروجی:</label><div class="pdf-format-select"><button class="pdf-format-btn active" data-format="png">PNG</button><button class="pdf-format-btn" data-format="jpeg">JPEG</button></div><div id="jpeg-quality-group" class="hidden" style="margin-top:8px"><label>کیفیت JPEG:</label><input type="range" id="jpeg-quality" min="50" max="100" value="85" style="width:150px"><span id="jpeg-quality-val">85%</span></div></div>
          </div>
          <div class="pdf-preview" id="pdf-preview" style="margin-bottom:16px"></div>
          <div class="pdf-toolbar"><button class="btn primary" id="btn-pdf-render-all">⚡ رندر همه صفحات</button><button class="btn secondary" id="btn-pdf-download-zip">📦 دانلود ZIP</button><button class="btn gray" id="btn-pdf-clear-previews">🗑️ پاک کردن پیش‌نمایش‌ها</button></div>
        </div>
      </div>

      <div class="card tab-content hidden" id="tab-translate">
        <h3>🌐 ترجمه متن (با هوش مصنوعی)</h3>
        <p class="muted">متن را بین زبان‌های مختلف ترجمه کنید — ترجمه طبیعی و روان با هوش مصنوعی</p>
        <div class="tl-lang-row">
          <select id="tl-from">
            <option value="fa">فارسی</option>
            <option value="en">انگلیسی</option>
            <option value="ar">عربی</option>
            <option value="fr">فرانسوی</option>
            <option value="de">آلمانی</option>
            <option value="tr">ترکی</option>
          </select>
          <button class="btn sm" onclick="tlSwap()">⇄</button>
          <select id="tl-to">
            <option value="en">انگلیسی</option>
            <option value="fa">فارسی</option>
            <option value="ar">عربی</option>
            <option value="fr">فرانسوی</option>
            <option value="de">آلمانی</option>
            <option value="tr">ترکی</option>
          </select>
        </div>
        <div class="tl-grid">
          <div><label>متن ورودی:</label><textarea id="tl-input" rows="8" dir="rtl" placeholder="متن خود را اینجا بنویسید..."></textarea></div>
          <div><label>ترجمه:</label><textarea id="tl-output" rows="8" dir="ltr" readonly placeholder="ترجمه اینجا نمایش داده می‌شود..."></textarea></div>
        </div>
        <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn primary" id="btn-translate">🌐 ترجمه کن</button>
          <button class="btn" onclick="tlCopy()">📋 کپی ترجمه</button>
          <button class="btn gray" onclick="tlClear()">🗑️ پاک کردن</button>
        </div>
      </div>

      <div class="card tab-content hidden" id="tab-ai">
        <div class="ai-chat-container">
          <div class="ai-header">
            <div class="ai-avatar">🤖</div>
            <div class="ai-title"><h3>دستیار هوش مصنوعی</h3><span class="ai-status">آنلاین</span></div>
            <div class="ai-mode-select"><select id="ai-mode"><option value="answer">💬 پاسخ به سوالات</option><option value="write">📝 نوشتن سوال</option><option value="correct">✏️ تصحیح متن</option><option value="translate">🌐 ترجمه</option></select></div>
          </div>
          <div id="ai-messages" class="ai-messages">
            <div class="ai-message ai"><div class="ai-message-avatar">🤖</div><div class="ai-message-content"><div class="ai-message-text">سلام! 👋 من دستیار هوش مصنوعی شما هستم. چطور می‌توانم کمکتان کنم؟</div></div></div>
          </div>
          <div class="ai-typing hidden" id="ai-typing">
            <div class="ai-message ai"><div class="ai-message-avatar">🤖</div><div class="ai-message-content"><div class="ai-typing-dots"><span></span><span></span><span></span></div></div></div>
          </div>
          <div class="ai-quick-actions">
            <button class="quick-action-btn" data-prompt="یک سوال تستی از درس ریاضی پایه هشتم بساز">📚 ساخت سوال</button>
            <button class="quick-action-btn" data-prompt="متن یک پیام تشویقی برای دانش‌آموزان بنویس">💬 پیام تشویقی</button>
            <button class="quick-action-btn" data-prompt="یک برنامه تدریس هفتگی برای معلم پیشنهاد بده">📅 برنامه تدریس</button>
            <button class="quick-action-btn" data-prompt="ایده‌هایی برای فعالیت‌های کلاسی خلاقانه">🎨 ایده خلاقانه</button>
          </div>
          <div class="ai-input-area">
            <textarea id="ai-input" placeholder="پیام خود را بنویسید..." rows="1"></textarea>
            <button class="btn primary ai-send-btn" id="btn-ai-send"><span>➤</span></button>
          </div>
        </div>
      </div>

      <div class="card tab-content hidden" id="tab-classroom">
        <h3>🖥️ کلاس آنلاین</h3>
        <div class="cls-status" style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <span class="dot" id="tdot" style="width:10px;height:10px;border-radius:50%;background:#dc2626;display:inline-block"></span>
          <span id="t-cls-status" class="muted">کلاس آنلاین شروع نشده</span>
          <span style="flex:1"></span>
          <button class="btn sm" id="btn-cls-start">▶️ شروع کلاس</button>
          <button class="btn sm gray hidden" id="btn-cls-stop">⏹️ پایان کلاس</button>
          <button class="btn sm sec hidden" id="btn-mic-toggle">🎙️ روشن کردن میکروفون</button>
          <button class="btn sm sec hidden" id="btn-cam-toggle">📷 روشن کردن تصویر</button>
        </div>
        <video id="t-cam-preview" autoplay muted playsinline class="hidden" style="width:160px;border-radius:10px;border:1px solid var(--line);margin-bottom:10px;background:#000"></video>

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
            <button class="lb-menu-btn" data-lb="absence"><span class="lb-ico">📋</span><span class="lb-t">ثبت غیبت دانش‌آموزان</span></button>
            <button class="lb-menu-btn" data-lb="performance"><span class="lb-ico">📈</span><span class="lb-t">ثبت سطوح عملکرد دانش‌آموز</span></button>
            <button class="lb-menu-btn" data-lb="council"><span class="lb-ico">🗣️</span><span class="lb-t">صورتجلسه شورای آموزشی اولیا</span></button>
            <button class="lb-menu-btn" data-lb="meetings"><span class="lb-ico">🤝</span><span class="lb-t">جلسات فردی با اولیا</span></button>
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
          </div>
          <div id="lbf-form-wrap" class="hidden">
            <div class="row" style="align-items:center;gap:14px;margin:10px 0">
              <img id="lbf-photo-preview" class="hidden" style="width:58px;height:58px;border-radius:50%;object-fit:cover;border:1px solid var(--line)">
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
          </div>
        </div>

      </div>

      <div class="card tab-content hidden" id="tab-settings">
        <h3>🌙 تم</h3>
        <div style="display:flex;gap:12px;margin-bottom:20px">
          <button class="theme-btn" data-theme="light" onclick="setTheme('light')">☀️ روشن</button>
          <button class="theme-btn" data-theme="dark" onclick="setTheme('dark')">🌙 تاریک</button>
        </div>
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
    if(t.dataset.tab==='answers')loadAnswers();
    if(t.dataset.tab==='tables')renderTables();
    if(t.dataset.tab==='schedule'){document.getElementById('btn-gen-schedule').click();}
    if(t.dataset.tab==='questions'){updateDurationDisplay();}
    if(t.dataset.tab==='classroom'){renderClassLinks();setTimeout(function(){if(typeof clsResizeBoard==='function')clsResizeBoard();},50);}
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

  // کوچک و فشرده کردن عکس پروفایل قبل از ارسال (حداکثر ابعاد 320px، حداکثر حجم اصلی 2 مگابایت)
  function resizeProfilePhoto(file){
    return new Promise((resolve,reject)=>{
      if(file.size>2*1024*1024){reject(new Error('حجم عکس باید کمتر از ۲ مگابایت باشد'));return;}
      const rd=new FileReader();
      rd.onload=ev=>{
        const img=new Image();
        img.onload=()=>{
          const c=document.createElement('canvas');const mw=320;let w=img.width,h=img.height;
          if(w>mw){h=Math.round(h*mw/w);w=mw;}
          c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);
          resolve(c.toDataURL('image/jpeg',0.85));
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
  function symBar(i){
    const mk=(arr,fn)=>arr.map(s=>'<button type="button" onmousedown="event.preventDefault()" onclick="'+fn+'('+i+',\\''+escA(s)+'\\')">'+escA(s)+'</button>').join('');
    let h='<div class="toolbar"><span class="grp-label">علائم ریاضی:</span>'+mk(MATH,'insSym')+
      '<button type="button" class="mt-open-btn" onmousedown="event.preventDefault()" onclick="openMathBuilder('+i+')">🧮 فرمول‌ساز (کسر، توان، رادیکال، ماتریس، تقسیم چکشی، جمع، انتگرال...)</button></div>';
    h+='<div class="toolbar"><span class="grp-label">اشکال هندسی:</span>'+
      '<span class="grp-label">اندازه:</span><input type="range" min="14" max="140" value="40" id="ssz-'+i+'" style="width:110px;vertical-align:middle" oninput="resizeSel('+i+')"> '+
      mk(SHAPES,'insShape')+
      SVG_SHAPES.map((s,si)=>'<button type="button" title="'+escA(s.name)+'" onmousedown="event.preventDefault()" onclick="insSvg('+i+','+si+')">'+escA(s.name)+'</button>').join('')+'</div>'+
      '<p class="muted" style="margin:2px 0 0">برای تغییر اندازه‌ی یک شکل، ابتدا روی آن کلیک کنید سپس نوار «اندازه» را بکشید.</p>';
    return h;
  }
  function qBlock(q,i){
    let body;
    if(q.type==='descriptive'){
      body='<label>متن سوال</label>'+symBar(i)+
        '<div class="rich" data-qd="'+i+'" contenteditable="true" oninput="updHtml('+i+')">'+qHtml(q)+'</div>';
    }else{
      body='<label>متن سوال</label><textarea data-qd="'+i+'" oninput="upd('+i+',\\'text\\',this.value)">'+esc(q.text)+'</textarea>';
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
    }

    // ===== عکس / شکل (برای همه‌ی انواع سوال) =====
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
        const c=document.createElement('canvas');const mw=800;let w=img.width,h=img.height;
        if(w>mw){h=Math.round(h*mw/w);w=mw;}
        c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);
        QUESTIONS[i].image=c.toDataURL('image/jpeg',0.85);renderQ();
      };img.src=ev.target.result;
    };rd.readAsDataURL(f);
  };
  window.rmImg=(i)=>{QUESTIONS[i].image='';QUESTIONS[i].imageWidth=0;renderQ();};
  window.updImgSize=(i,val)=>{QUESTIONS[i].imageWidth=parseInt(val,10)||320;renderQ();};
  
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
      loadAnswers();
    };
  });
  
  async function loadAnswers(){
    const d=await api('/api/teacher/submissions');
    SUBS=d.submissions||[];
    const box=document.getElementById('answers-list');
    if(!SUBS.length){box.innerHTML='<p class="muted">هنوز پاسخنامه‌ای ثبت نشده است.</p>';return;}
    box.innerHTML=SUBS.map((s,si)=>{
      const g=s.grading||{graded:false,feedback:{},marks:{},overall:''};
      const isNumeric = GRADING_TYPE === 'numeric';
      const rows=(s.questionsSnapshot||[]).map((q,i)=>{
        const ans=s.answers?s.answers[q.id]:'';
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
        
        return '<tr><td>'+(i+1)+'</td><td>'+qHtml(q)+(q.image?'<br><img src="'+q.image+'" class="imgprev" style="max-width:'+(q.imageWidth||320)+'px;width:100%">':'')+'</td>'+
          '<td>'+(ansText(q,ans)||'<i>بدون پاسخ</i>')+'</td>'+
          '<td>'+gradeCell+'</td>'+
          '<td><input type="text" id="fb_'+s.uuid+'_'+q.id+'" value="'+esc(fb)+'" placeholder="بازخورد"></td></tr>';
      }).join('');
      const badge=g.graded?'<span class="pill ok">✅ تصحیح‌شده</span>':'<span class="pill gr">⏳ در انتظار تصحیح</span>';
      
      const statusHeader = isNumeric ? 'نمره' : 'وضعیت';
      const feedbackLabel = isNumeric ? 'توضیحات (اختیاری)' : 'بازخورد';
      
      return '<div class="q-block"><div class="qhead"><b>'+esc(s.student.name)+'</b> '+badge+
        ' <a class="btn sm sec" href="/api/teacher/word?type=answers&uuid='+s.uuid+'">📄 دانلود Word</a></div>'+
        '<p class="muted">نام پدر: '+esc(s.student.fatherName)+' | کد ملی: '+esc(s.student.nationalId)+' | نام درس: '+esc(s.student.courseName||'')+' | تاریخ آزمون: '+esc(s.student.examDate||'')+' | ثبت: '+new Date(s.submittedAt).toLocaleString('fa-IR')+'</p>'+
        '<table><tr><th>#</th><th>سوال</th><th>پاسخ دانش‌آموز</th><th>'+statusHeader+'</th><th>'+feedbackLabel+'</th></tr>'+rows+'</table>'+
        '<label>'+feedbackLabel+' کلی</label><textarea id="ov_'+s.uuid+'">'+esc(g.overall||'')+'</textarea>'+
        '<button class="btn" style="margin-top:8px" onclick="saveGrade(\\''+s.uuid+'\\')">ثبت تصحیح</button></div>';
    }).join('');
  }
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
    style+='table{width:100%;border-collapse:separate;border-spacing:0;border-radius:18px;overflow:hidden;box-shadow:0 8px 24px rgba(15,23,42,.10);border:1px solid #e2e8f0}';
    style+='th{padding:14px 8px;font-size:14px;font-weight:800;text-align:center;border-bottom:2px solid #e2e8f0;border-left:1px solid #e2e8f0}';
    style+='td{padding:14px 10px;text-align:center;font-size:13px;min-height:50px;font-weight:600;color:#1e293b;border-bottom:1px solid #eef2f6;border-left:1px solid #eef2f6}';
    style+='tr:last-child td{border-bottom:none}';
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
    const footer='<div class="footer"><p>امضای مدیر: ___________________</p><p>تاریخ: ___________________</p></div>';
    return '<html><head><meta charset="utf-8">'+style+'</head><body>'+header+table+footer+'</body></html>';
  }

  document.getElementById('btn-print-schedule').onclick=function(){const w=window.open('','_blank');w.document.write(getScheduleHtmlForExport());w.document.close();setTimeout(function(){w.print();},500);};
  document.getElementById('btn-word-schedule').onclick=function(){const blob=new Blob([getScheduleHtmlForExport()],{type:'application/msword'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='برنامه-هفتگی.doc';a.click();};
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
    const thead=document.getElementById('custom-table-head');
    const tbody=document.getElementById('custom-table-body');
    const tfoot=document.getElementById('custom-table-foot');

    let ch='<tr><th class="xls-corner"></th>';
    for(let c=1;c<=cols;c++){ch+='<th class="xls-colhead">'+colLetter(c)+'</th>';}
    ch+='</tr>';
    ch+='<tr class="xls-titlerow"><th class="xls-rowhead">#</th>';
    for(let c=1;c<=cols;c++){ch+='<th><input type="text" id="'+xlsTitleId(c)+'" placeholder="عنوان ستون '+c+'" value="ستون '+c+'"></th>';}
    ch+='</tr>';
    thead.innerHTML=ch;

    let b='';
    for(let r=1;r<=rows;r++){
      b+='<tr><td class="xls-rowhead">'+r+'</td>';
      for(let c=1;c<=cols;c++){b+='<td><input type="text" id="'+xlsCellId(r,c)+'" data-r="'+r+'" data-c="'+c+'"></td>';}
      b+='</tr>';
    }
    tbody.innerHTML=b;
    tfoot.innerHTML='';
    if(document.getElementById('tbl-avg-check').checked)calcAndShowAvg();
  };

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
  document.getElementById('tbl-avg-check').onchange=function(){this.checked?calcAndShowAvg():document.getElementById('custom-table-foot').innerHTML='';};
  // محاسبه‌ی زنده‌ی میانگین با هر بار تایپ در سلول‌های عددی
  document.getElementById('custom-table-body').addEventListener('input',function(e){
    if(e.target && e.target.tagName==='INPUT' && document.getElementById('tbl-avg-check').checked) calcAndShowAvg();
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
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=title+'.doc';a.click();
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
      const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=title+'.xlsx'; a.click();
      toast('فایل Excel ساخته شد ✅');
    }catch(err){
      toast('خطا در ساخت فایل Excel — اتصال اینترنت را بررسی کنید');
    }finally{
      btn.disabled=false; btn.textContent=origText;
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
    rd.onload=ev=>{const img=new Image();img.onload=()=>{SCANIMG=img;SCANORIG=img;scanRotation=0;document.getElementById('scan-controls').classList.remove('hidden');scanDropZone.classList.add('hidden');applyScan();};img.onerror=()=>{toast('فایل عکس معتبر نیست');};img.src=ev.target.result;};
    rd.onerror=()=>{toast('خطا در خواندن فایل');};
    rd.readAsDataURL(file);
  }

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


  document.getElementById('btn-reset-scan').onclick=()=>{SCANORIG=SCANIMG;scanRotation=0;document.getElementById('scan-bright').value=0;document.getElementById('scan-contrast').value=0;document.getElementById('scan-sharp').value=0;document.getElementById('scan-saturation').value=0;updateFilterValues();document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));document.querySelector('.filter-btn[data-filter="original"]').classList.add('active');applyScan();};
  document.getElementById('btn-remove-scan').onclick=()=>{if(!confirm('عکس فعلی حذف شود؟'))return;SCANIMG=null;SCANORIG=null;scanRotation=0;document.getElementById('scan-controls').classList.add('hidden');document.getElementById('scan-drop-zone').classList.remove('hidden');document.getElementById('scan-file').value='';document.getElementById('scan-bright').value=0;document.getElementById('scan-contrast').value=0;document.getElementById('scan-sharp').value=0;document.getElementById('scan-saturation').value=0;updateFilterValues();document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));document.querySelector('.filter-btn[data-filter="original"]').classList.add('active');};
  document.getElementById('btn-dl-img').onclick=()=>{if(!SCANORIG){toast('ابتدا عکس را انتخاب کنید');return;}const cv=document.getElementById('scan-canvas');cv.toBlob(blob=>{const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='اسکن.png';document.body.appendChild(a);a.click();a.remove();},'image/png');};
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
      const a=document.createElement('a');a.href=URL.createObjectURL(zipBlob);a.download='عکس‌های_فشرده.zip';a.click();
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
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png', 1.0);
    a.download = cropFileName.replace(/\.[^.]+$/, '_cropped.png');
    a.click();
    toast('عکس برش‌خورده دانلود شد ✅');
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

  async function renderPdfPage(pageNum){if(!pdfDoc)return;const page=await pdfDoc.getPage(pageNum);const dpi=parseInt(document.querySelector('.pdf-dpi-btn.active')?.dataset.dpi)||150;const scale=dpi/72;const viewport=page.getViewport({scale});const canvas=document.createElement('canvas');canvas.width=viewport.width;canvas.height=viewport.height;const ctx=canvas.getContext('2d');await page.render({canvasContext:ctx,viewport}).promise;const format=document.querySelector('.pdf-format-btn.active')?.dataset.format||'png';const dataUrl=canvas.toDataURL('image/'+format,format==='jpeg'?parseInt(document.getElementById('jpeg-quality')?.value||85)/100:undefined);const previewDiv=document.getElementById('pdf-preview');const pageDiv=document.createElement('div');pageDiv.className='pdf-page-preview';pageDiv.style.cssText='display:inline-block;margin:8px;text-align:center;background:#fff;border:1px solid #ddd;border-radius:8px;padding:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1)';pageDiv.innerHTML='<div style="font-weight:bold;margin-bottom:8px">صفحه '+pageNum+'</div><img src="'+dataUrl+'" style="max-width:200px;max-height:280px;border:1px solid #eee"><div style="margin-top:8px"><button class="btn sm primary" onclick="downloadPdfPage('+pageNum+')">📥 دانلود</button></div>';previewDiv.appendChild(pageDiv);pdfRenderedPages.push({pageNum,canvas,dataUrl});return canvas;}
  window.downloadPdfPage=function(pageNum){const rp=pdfRenderedPages.find(p=>p.pageNum===pageNum);if(!rp){toast('صفحه رندر نشده');return;}const format=document.querySelector('.pdf-format-btn.active')?.dataset.format||'png';const ext=format==='jpeg'?'jpg':format;const a=document.createElement('a');a.href=rp.dataUrl;a.download=pdfFileName.replace('.pdf','_page_'+pageNum+'.'+ext);a.click();toast('صفحه '+pageNum+' دانلود شد ✅');};
  document.getElementById('pdf-remove').onclick=()=>{pdfDoc=null;pdfFileName='';pdfRenderedPages=[];document.getElementById('pdf-controls').classList.add('hidden');document.getElementById('pdf-preview').innerHTML='';};
  document.querySelectorAll('.pdf-select-btn').forEach(btn=>{btn.onclick=()=>{document.querySelectorAll('.pdf-select-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');const type=btn.dataset.pages;document.getElementById('pdf-range').classList.toggle('hidden',type!=='range');};});
  document.querySelectorAll('.pdf-dpi-btn').forEach(btn=>{btn.onclick=()=>{document.querySelectorAll('.pdf-dpi-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');};});
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
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=pdfFileName.replace(/\.pdf$/i,'')+'_pages.zip';a.click();
      toast('فایل ZIP شامل '+pdfRenderedPages.length+' صفحه دانلود شد ✅');
    }catch(e){
      toast('خطا در ساخت فایل ZIP');
    }finally{
      btn.disabled=false;btn.textContent=origText;
    }
  };

  // ===== ترجمه =====
  document.getElementById('tl-from').onchange=function(){const f=this.value;const t=document.getElementById('tl-to');if(f===t.value){t.value=f==='fa'?'en':'fa';}};
  const tlLangNames={fa:'فارسی',en:'انگلیسی',ar:'عربی',fr:'فرانسوی',de:'آلمانی',tr:'ترکی'};
  const tlLangDir={fa:'rtl',ar:'rtl',en:'ltr',fr:'ltr',de:'ltr',tr:'ltr'};
  function tlUpdateDirs(){
    document.getElementById('tl-input').dir=tlLangDir[document.getElementById('tl-from').value]||'rtl';
    document.getElementById('tl-output').dir=tlLangDir[document.getElementById('tl-to').value]||'ltr';
  }
  document.getElementById('tl-from').addEventListener('change',tlUpdateDirs);
  document.getElementById('tl-to').addEventListener('change',tlUpdateDirs);
  window.tlSwap=function(){
    const f=document.getElementById('tl-from');const t=document.getElementById('tl-to');
    const tmp=f.value;f.value=t.value;t.value=tmp;
    const inp=document.getElementById('tl-input');const out=document.getElementById('tl-output');
    const t2=inp.value;inp.value=out.value;out.value=t2;
    tlUpdateDirs();
  };
  window.tlCopy=function(){const txt=document.getElementById('tl-output').value;if(!txt){toast('متنی وارد نشده');return;}navigator.clipboard.writeText(txt).then(()=>toast('کپی شد ✅'));};
  window.tlClear=function(){document.getElementById('tl-input').value='';document.getElementById('tl-output').value='';};
  document.getElementById('btn-translate').onclick=async function(){
    const text=document.getElementById('tl-input').value.trim();
    if(!text){toast('متنی وارد نشده');return;}
    const from=document.getElementById('tl-from').value, to=document.getElementById('tl-to').value;
    if(from===to){toast('زبان مبدا و مقصد یکسان است');return;}
    const btn=this;btn.disabled=true;btn.textContent='⏳ در حال ترجمه...';
    try{
      const sys='You are a professional translator. Translate the text the user sends from '+tlLangNames[from]+' ('+from+') to '+tlLangNames[to]+' ('+to+'). '+
        'Respond with ONLY the translation itself — natural and fluent, no quotes, no explanations, no extra commentary, no original text repeated.';
      const res=await fetch('/api/teacher/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'system',content:sys},{role:'user',content:text}]})});
      const data=await res.json();
      if(data.error){toast('خطا در ترجمه: '+data.error);}
      else{document.getElementById('tl-output').value=(data.content||'').trim();tlUpdateDirs();toast('ترجمه شد ✅');}
    }catch(e){toast('خطا در اتصال');}
    btn.disabled=false;btn.textContent='🌐 ترجمه کن';
  };

  // ===== AI Chat =====
  let aiMessages=[{role:'system',content:'تو یک دستیار هوشمند برای معلمان هستی. به زبان فارسی پاسخ بده.'}];
  document.querySelectorAll('.quick-action-btn').forEach(btn=>{btn.onclick=()=>{const prompt=btn.dataset.prompt;document.getElementById('ai-input').value=prompt;document.getElementById('btn-ai-send').click();};});
  const aiInput=document.getElementById('ai-input');
  aiInput.addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px';});
  function addAiMessage(role,text){const box=document.getElementById('ai-messages');const isUser=role==='user';const html='<div class="ai-message '+(isUser?'user':'ai')+'"><div class="ai-message-avatar">'+(isUser?'👤':'🤖')+'</div><div class="ai-message-content"><div class="ai-message-text">'+esc(text)+'</div></div></div>';box.insertAdjacentHTML('beforeend',html);box.scrollTop=box.scrollHeight;}
  function showTyping(){document.getElementById('ai-typing').classList.remove('hidden');document.getElementById('ai-messages').scrollTop=document.getElementById('ai-messages').scrollHeight;}
  function hideTyping(){document.getElementById('ai-typing').classList.add('hidden');}
  document.getElementById('btn-ai-send').onclick=async()=>{const text=aiInput.value.trim();if(!text)return;aiInput.value='';aiInput.style.height='auto';addAiMessage('user',text);aiMessages.push({role:'user',content:text});showTyping();const box=document.getElementById('ai-messages');try{const mode=document.getElementById('ai-mode').value;let systemPrompt='تو یک دستیار هوشمند برای معلمان هستی. به زبان فارسی پاسخ بده.';if(mode==='write')systemPrompt='تو یک معلم باتجربه هستی. سوالات تستی و تشریحی باکیفیت بساز.';if(mode==='correct')systemPrompt='تو یک معلم باتجربه هستی. متون را تصحیح کن و پیشنهاد بده.';if(mode==='translate')systemPrompt='تو یک مترجم حرفه‌ای هستی. ترجمه‌ها را طبیعی و روان انجام بده.';const msgs=[{role:'system',content:systemPrompt},...aiMessages.slice(-10)];const res=await fetch('/api/teacher/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:msgs})});const d=await res.json();hideTyping();if(d.error){addAiMessage('ai','❌ خطا: '+d.error);return;}addAiMessage('ai',d.content);aiMessages.push({role:'assistant',content:d.content});}catch(e){hideTyping();addAiMessage('ai','❌ خطا در اتصال: '+e.message);}};
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
  let clsCamStream=null, clsCamInterval=null, clsAudioFromCam=false;
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
    clsAudioFromCam=false;
    if(clsWs)clsWs.close();
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
      clsSend({type:'video-stop'});
      if(clsAudioFromCam){ clsStopMicRecorder(); clsAudioFromCam=false; }
      return;
    }
    try{
      clsCamStream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:320},height:{ideal:240}}, audio:true});
      preview.srcObject=clsCamStream;
      preview.classList.remove('hidden');
      this.textContent='🔴 خاموش کردن تصویر';
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

  // ===================== دفتر مدیریت کلاسی =====================
  // --- ناوبری منو ---
  document.querySelectorAll('.lb-menu-btn').forEach(function(b){
    b.onclick=function(){
      document.getElementById('lb-menu').classList.add('hidden');
      const panel=document.getElementById('lb-panel-'+b.dataset.lb);
      if(panel)panel.classList.remove('hidden');
      if(b.dataset.lb==='pacing'){lbRenderPacing();lbLoadPacingIfNeeded(lbSelectedGradeIdx());}
      if(b.dataset.lb==='roster')lbLoadRosterIfNeeded();
      if(b.dataset.lb==='absence')lbLoadAbsenceIfNeeded();
      if(b.dataset.lb==='performance'){
        document.getElementById('lbf-form-wrap').classList.add('hidden');
        LB_PERF_CURRENT_UUID=null;
        lbRenderPerfStudentList(lbSelectedPerfGradeIdx());
      }
      if(b.dataset.lb==='council')lbLoadCouncilIfNeeded();
      if(b.dataset.lb==='meetings')lbLoadMeetingsIfNeeded();
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
    var style='<style>'+pageCss+' body{direction:rtl;font-family:tahoma,Arial;padding:6px}h1,h2,h3{text-align:center}table{width:100%;border-collapse:collapse;margin:10px 0}th,td{border:1px solid #333;padding:'+(landscape?'4px':'6px')+';text-align:center;font-size:'+(landscape?'10px':'12px')+'}th{background:#dbeafe}.lb-meta{margin-bottom:14px;font-size:14px}.lb-nowruz{background:#16a34a;color:#fff;font-weight:bold}</style>';
    var blob=new Blob(['<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8">'+style+'<title>'+esc(title)+'</title></head><body><div class="Section1"><h2>'+esc(title)+'</h2>'+bodyHtml+'</div></body></html>'],{type:'application/msword'});
    var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename+'.doc';a.click();
  }
  function lbPrintExport(title,bodyHtml,landscape){
    var style='<style>@page{size:A4 '+(landscape===false?'portrait':'landscape')+';margin:8mm}body{direction:rtl;font-family:tahoma,Arial;padding:6px}h1,h2,h3{text-align:center}table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #333;padding:4px;text-align:center;font-size:10px}th{background:#dbeafe}.lb-meta{margin-bottom:10px;font-size:12px}.lb-nowruz{background:#16a34a;color:#fff;font-weight:bold}</style>';
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
      var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename+'.xlsx';a.click();
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
    h+='<tr><th rowspan="2">نام درس</th><th rowspan="2">مهم‌ترین انتظارات آموزشی</th><th colspan="'+cols+'">ثبت عملکرد دانش‌آموز</th><th rowspan="2">توصیف کوتاه موارد ضروری</th></tr>';
    h+='<tr>';
    for(var c=0;c<cols;c++){
      h+=forExport?'<th style="min-width:22px">'+(c+1)+'</th>':'<th style="min-width:34px">'+(c+1)+'</th>';
    }
    h+='</tr></thead><tbody id="lb-perf-tbody">';
    subjects.forEach(function(subj){
      var key=subj.name;
      var saved=LB_PERF_DATA[key]||{};
      var defaultExpect=subj.items.join('\\n');
      var expectVal=(saved.expect!==undefined)?saved.expect:defaultExpect;
      var rowsCount=Math.max(subj.items.length,1);
      h+='<tr data-subj="'+esc(subj.name)+'">';
      h+='<td style="font-weight:700;background:#f1f5f9">'+esc(subj.name)+'</td>';
      h+=forExport?'<td>'+esc(expectVal).replace(/\\n/g,'<br>')+'</td>':'<td><textarea class="lb-perf-expect" data-key="'+key+'" rows="'+Math.min(rowsCount,8)+'" placeholder="انتظار آموزشی">'+esc(expectVal)+'</textarea></td>';
      for(var c2=0;c2<cols;c2++){
        var v=(saved.cols&&saved.cols[c2])||'';
        h+=forExport?'<td>'+esc(v)+'</td>':'<td><input type="text" class="lb-perf-cell" data-key="'+key+'" data-col="'+c2+'" value="'+esc(v)+'"></td>';
      }
      h+=forExport?'<td>'+esc(saved.desc||'').replace(/\\n/g,'<br>')+'</td>':'<td><textarea class="lb-perf-desc" data-key="'+key+'" rows="'+Math.min(rowsCount,8)+'" placeholder="توضیح کوتاه">'+esc(saved.desc||'')+'</textarea></td>';
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
    document.getElementById('lbf-form-wrap').classList.remove('hidden');
    lbRenderPerformance();
  }
  document.getElementById('lbf-student-select').addEventListener('change',function(){
    if(this.value)lbPerfLoadStudent(this.value);
    else document.getElementById('lbf-form-wrap').classList.add('hidden');
  });
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
    LB_PERF_CURRENT_UUID=null;
    lbRenderPerfStudentList(lbSelectedPerfGradeIdx());
  });
  function lbPerformanceExportHtml(){
    var gradeText=document.getElementById('lbf-grade-select').selectedOptions[0].textContent;
    var studentName=document.getElementById('lbf-student-name').value||'';
    var photoHtml=LB_PERF_PHOTO?('<img src="'+LB_PERF_PHOTO+'" style="float:left;width:58px;height:58px;border-radius:50%;object-fit:cover;border:1px solid #94a3b8;margin:0 0 8px 10px">'):'';
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
        var expectVal=(saved.expect!==undefined)?saved.expect:subj.items.join('\\n');
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
  // ===================== پایان دفتر مدیریت کلاسی =====================

  checkAuth();
  `;
}
