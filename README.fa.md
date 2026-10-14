# AStack Enterprise

**زبان‌ها:** [English](README.md) · فارسی · [العربية](README.ar.md) · [Türkçe](README.tr.md) — **مستندات:** [فهرست مستندات](documentation/README.md)

AStack Enterprise یک سیستم‌عامل هوش مصنوعی ماژولار است که به‌طور هم‌تراز داخل Claude Code و OpenAI Codex اجرا می‌شود — یک قرارداد، یک حافظه و یک دفترچه رویداد مشترک — و برای ChatGPT و رانتایم‌های آینده نیز باز است. این سیستم هر نوع کاری را مدیریت می‌کند — توسعه نرم‌افزار، پرونده‌های حقوقی، امور مالی، مالیاتی، حسابداری، بازاریابی، عملیات، منابع انسانی، تحقیق و استراتژی کسب‌وکار — با تشکیل تیم‌های تخصصی، ساخت ایجنت‌ها و سپردن مأموریت‌های زمان‌بندی‌شده زیر نظر لایه رهبری. از نسخه ۳ همیشه روشن است و **در جیب شما**: یک اجراکننده خودکار و یک پردازش پس‌زمینه، مأموریت‌ها، کارهای زمان‌بندی‌شده و هوک‌ها را حتی وقتی کسی پشت سیستم نیست جلو می‌برند؛ از تلگرام یا واتس‌اپ به آن دستور می‌دهید و قدم‌های برگشت‌ناپذیرش را از همان‌جا تأیید می‌کنید؛ و **آرامین**، کنسولی محلی که مثل اپ نصب می‌شود، همه تأییدها، مأموریت‌ها، اجراها و سوابق ممیزی را نشان می‌دهد. همه این توانایی‌های تازه داخل همان مدل اعتماد قبلی کار می‌کنند: سقف اختیار، رسید تأیید و ردّ ممیزی.

## امکانات

**رانتایم‌ها و هماهنگی**
- Claude Code و Codex هم‌تراز، روی یک قرارداد، یک حافظه و یک دفترچه رویداد ([مستند](documentation/Codex-and-Claude-Code.md))
- گراف کد Graphify با بودجه توکن AStack ([مستند](documentation/Graphify.md))
- درگاه A2A: ایجنت‌های دیگر می‌توانند از AStack برنامه بخواهند؛ فقط روی همین دستگاه، با توکن، و به‌طور پیش‌فرض فقط برنامه می‌دهد و چیزی اجرا نمی‌کند ([مستند](documentation/Board-Sandbox-Vault.md#a2a-endpoint-interop-enginea2a-servermjs)) — *تازه در ۳*

**همیشه روشن** — *تازه در ۳*
- **اجراکننده (runner)** — `astack run` یک هدف یا مأموریت را بدون حضور شما اجرا می‌کند: با Claude Code بی‌رابط، `codex exec` یا یک مدل محلی Ollama؛ با سقف هزینه روزانه و هر اجرا، محدودیت اجرای هم‌زمان، و سقف اختیاری که در خود ابزارها اعمال می‌شود، نه فقط در متن دستور ([مستند](documentation/Runner-and-Daemon.md))
- **پردازش پس‌زمینه (daemon)** — یک پردازش، صف اجراکننده، زمان‌بند، شنونده هوک‌ها، پیام‌رسان، به‌روزرسانی ایندکس جست‌وجو، تابلوی کار و کنسول را نگه می‌دارد و اگر یکی از کار افتاد دوباره راهش می‌اندازد؛ به‌صورت سرویس سیستم‌عامل نصب می‌شود: Task Scheduler در ویندوز، LaunchAgent در مک و سرویس کاربری systemd در لینوکس ([مستند](documentation/Runner-and-Daemon.md#daemon-daemon-engine))
- **تابلوی کار (board)** — کانبان پایدار چندایجنتی با وابستگی، تلاش دوباره، بازبین مستقل و هدایت در حین کار ([مستند](documentation/Board-Sandbox-Vault.md#board-board-engine))

**در جیب شما** — *تازه در ۳*
- **پیام‌رسان (gateway)** — فرمان دادن به AStack از تلگرام یا واتس‌اپ (از طریق درگاه HTTP سازگار با wapi، پل «دستگاه متصل» خود AStack، یا Cloud API متا)؛ فهرست مجاز مالک با چند حساب در هر کانال؛ تأیید با «بفرست» یا «تایید» و رد با «نه» یا «رد»؛ تبدیل پیام صوتی فارسی به متن، روی همین دستگاه ([مستند](documentation/Gateway.md))
- **کنسول آرامین** — اپ وب محلی و نصب‌شدنی (PWA) برای تأییدها، مأموریت‌ها، حافظه، اجراها، کارهای پس‌زمینه، ممیزی، مهارت‌ها، تابلوی کار و وضعیت سیستم؛ فقط روی همین دستگاه، ورود با توکن، فارسی به‌طور پیش‌فرض ([مستند](documentation/Aramin-Console.md))

**حافظه و یادآوری**
- **حافظه چندوجهی زمان‌مند** — دوازده وجه حافظه، جایگزینی به‌جای بازنویسی، تجمیع شبانه ([مستند](documentation/Memory-OS.md))
- **جست‌وجو** — یک ایندکس فارسی‌فهم روی حافظه، گفتگوهای قبلی Claude Code و Codex، گزارش‌ها، مهارت‌ها و مأموریت‌ها: SQLite FTS5 به‌اضافه بردارهای معنایی Ollama (اختیاری)، و یک نیم‌رخ ثابت و قابل بازتولید از مالک ([مستند](documentation/Search.md)) — *تازه در ۳*
- **موتور زمینه** — نقشه فضای کاری، ایندکس نمادها و گراف رکوردهای دامنه‌ای در بودجه توکن مشخص ([مستند](documentation/Context-Engine.md))
- **گراف دانش** — اشخاص، شرکت‌ها، پرونده‌ها و حساب‌ها و رابطه‌شان در طول زمان ([مستند](documentation/Knowledge-Graph.md))

**مهارت‌ها و یادگیری**
- **یادگیری خودکار** — کار تکراری به یک skill نسخه‌دار و مستند تبدیل می‌شود ([مستند](documentation/Learning-Engine.md))
- **مرکز مهارت (skill hub)** — مهارت‌های `SKILL.md` در بسته‌های کمکی وارد می‌شوند، با یک اسکنر امنیتی بررسی می‌شوند و همیشه پایین‌تر از مهارت‌های داخلی رتبه می‌گیرند؛ بسته Hermes Agent (۲۱۱ مهارت با مجوز MIT) همراهش است؛ مهارت‌های پرخطر هرگز خودکار انتخاب نمی‌شوند و دو مهارت به‌کلی مسدودند؛ یک بازبین هم پیشنهاد می‌دهد کدام مهارت بماند، اصلاح شود یا کنار برود ([مستند](documentation/Skill-Hub.md)) — *تازه در ۳*

**کار واقعی، با احتیاط**
- **مأموریت‌ها** — پایدار و قابل ادامه، با نقطه‌های توقف برای تأیید، اجرای آزمایشی و بازپخش ([مستند](documentation/Autonomous-Organization.md))
- **مرورگر داخلی** — ورود ماندگار، کار واقعی با فرم‌ها، شواهد زنجیره‌ای و توقف پیش از ثبت نهایی ([مستند](documentation/Browser-Operator.md))
- **زمان‌بند و هوک‌ها** — پایش پس‌زمینه و رویدادهای ورودی که مأموریت می‌سازند یا کاری را در صف اجراکننده می‌گذارند ([مستند](documentation/Scheduler-and-Signals.md))
- **محیط ایزوله (sandbox)** — اجرای فرمان داخل داکر: بدون شبکه، فایل‌سیستم فقط‌خواندنی، اسرار پنهان ([مستند](documentation/Board-Sandbox-Vault.md#sandbox-sandbox-engine)) — *تازه در ۳*

**اعتماد**
- سطوح اختیار L0 تا L5، رسید تأیید، ردّ ممیزی و بروکر اعتبارنامه ([مستند](documentation/Security-and-Authority.md))
- گاوصندوق سیستم‌عامل برای اسرار (DPAPI ویندوز؛ و آداپتورهای Keychain مک، Secret Service لینوکس، Bitwarden و 1Password) و محافظی که هر رمزِ بازشده را از همه خروجی‌ها پاک می‌کند ([مستند](documentation/Board-Sandbox-Vault.md#vault-backends-trust-enginevaultmjs)) — *تازه در ۳*

**سازمان و تحویل**
- ده دامنه کاری، ۳۳ دپارتمان، ۲۱۹ نقش، تیم‌ها، ایجنت‌ها و لایه رهبری ([مستند](documentation/Orchestration.md))
- تحویل مرحله‌ای پروژه با PERT، WSJF، محدودیت WIP، پیش‌بینی مونت‌کارلو و EVM ([مستند](documentation/Project-Management.md))
- ارتقای امن هسته با نسخه پشتیبان، ادغام سه‌طرفه تغییرات شما و بازگشت خودکار در صورت خطا ([مستند](documentation/Upgrade.md))

## رانتایم
- رانتایم‌ها: Claude Code و Codex به‌صورت هم‌تراز ([مغز مشترک](documentation/Codex-and-Claude-Code.md)، [چرخه کار Claude Code](documentation/Claude-Code.md))؛ اجرای بدون حضور شما با [اجراکننده](documentation/Runner-and-Daemon.md)
- گراف کد: [Graphify](documentation/Graphify.md) با بودجه توکن AStack برای هر دو رانتایم (`node bin/astack.mjs graphify setup`)
- قرارداد مشترک: `AGENTS.md` (Codex مستقیم می‌خواند و `CLAUDE.md` آن را import می‌کند)؛ سیم‌کشی هر دو: `node bin/astack.mjs interop sync`
- ارتباط با مالک: فارسی — کد و مستندات فنی: انگلیسی
- معماری: لایه‌ای، توسعه‌پذیر با پلاگین، مستقل از ارائه‌دهنده، دامنه‌آگاه ([جزئیات](documentation/Architecture.md))

## نصب در هر پروژه
پروژه جدید یا قدیمی، با یا بدون AStack — یک دستور هسته، Claude Code و Codex، Graphify، ایندکس و مهارت سراسری `astack-setup` را راه‌اندازی می‌کند (از آن به بعد کافی است به هر کدام بگویید «نصب شو» یا «راه‌اندازی شو»):
```bash
git clone --depth 1 https://github.com/ARaminco/AStack.git ~/.astack/core   # یا: git -C ~/.astack/core pull
node ~/.astack/core/bin/astack.mjs setup --target /path/to/project
```
برای آپدیت هر پروژه کافی است به Claude Code یا Codex بگویید «آپدیت کن» یا [پایپ‌لاین آپدیت](documentation/Upgrade.md) را مستقیم اجرا کنید: `node ~/.astack/core/bin/astack.mjs update --target /path/to/project`.

## شروع سریع
```bash
npm test
node bin/astack.mjs doctor
node bin/astack.mjs interop sync && node bin/astack.mjs interop status
node bin/astack.mjs domain detect "اظهارنامه مالیات ارزش افزوده"
node bin/astack.mjs lead plan "پرونده حقوقی قرارداد ملکی"
node bin/astack.mjs lead team "پرونده حقوقی قرارداد ملکی" --name legal-case-team
node bin/astack.mjs project init "Contract Dispute" --template legal-case
node bin/astack.mjs lead delegate contract-dispute --team legal-case-team
node bin/astack.mjs agent run-due
node bin/astack.mjs lead standup
```
ادامه در [راهنمای نصب](documentation/Installation.md) و [مرجع فرمان‌ها](documentation/API.md).

### روشن کردن دستیار همیشه‌روشن (نسخه ۳)
همه موتورهای تازه تا وقتی خودتان روشنشان نکنید خاموش یا فقط‌خواندنی‌اند. چهار قدم:

```bash
# ۱. اجراکننده: یک بار اجازه بدهید Claude Code بدون حضور شما اجرا شود، بعد یک اجرای آزمایشی ببینید
node bin/astack.mjs schedule policy allow-command claude
node bin/astack.mjs runner engines
node bin/astack.mjs run "خلاصه مأموریت‌های باز امروز" --dry-run

# ۲. پردازش پس‌زمینه: یک پردازش برای اجراکننده، زمان‌بند، هوک‌ها، پیام‌رسان، جست‌وجو، تابلوی کار و کنسول
node bin/astack.mjs daemon start
node bin/astack.mjs daemon status
node bin/astack.mjs daemon install-service --dry-run   # برنامه را ببینید، بعد بدون --dry-run اجرا کنید تا با ورود به سیستم خودش بالا بیاید

# ۳. کنسول آرامین: تا وقتی پردازش پس‌زمینه روشن است، مرورگر را واردشده باز می‌کند
node bin/astack.mjs console open                        # بدون پردازش پس‌زمینه: astack console start --open

# ۴. پیام‌رسان تلگرام: اول با @BotFather یک ربات بسازید
node bin/astack.mjs secret vault set credential://telegram/bot           # توکن ربات را در خط پنهان بچسبانید
node bin/astack.mjs gateway owner add telegram <شناسه عددی تلگرام شما>
```

بعد پیام‌رسان را در `astack.config.yaml` روشن کنید و پردازش پس‌زمینه را دوباره راه بیندازید:

```yaml
gateway:
  enabled: true
  channels:
    telegram:
      enabled: true
```

```bash
node bin/astack.mjs gateway test telegram     # فقط بررسی سلامت، چیزی نمی‌فرستد
node bin/astack.mjs daemon stop && node bin/astack.mjs daemon start
```

حالا به ربات پیام بدهید: پیام شما یک درخواست برای اجراکننده می‌شود. درخواست‌های تأیید با مقدارهای دقیق و یک کد چهارحرفی می‌رسند؛ روی همان پیام جواب بدهید «بفرست» یا «تایید» (یا «نه» / «رد»). کانال‌های واتس‌اپ، پیام صوتی و همه قاعده‌ها در [راهنمای پیام‌رسان](documentation/Gateway.md) آمده است.

## ارتقا به نسخه ۳
نسخه ۳ فقط چیز اضافه می‌کند: هر فرمان، قالب فایل و تست نسخه 2.5.1 بی‌تغییر کار می‌کند و همه موتورهای تازه تا تنظیم نشوند خاموش یا فقط‌خواندنی‌اند. آپدیت مثل همیشه است:

```bash
node bin/astack.mjs update            # یا به Claude Code / Codex بگویید «آپدیت کن»
```

آپدیت موتورهای تازه و پوشه `skill-packs/` را می‌آورد، به `astack.config.yaml` دست نمی‌زند (بخش‌های نسخه ۳ به‌صورت پیش‌فرض‌های کامنت‌شده می‌آیند) و مهاجرت `2026.8-ignore-v3-state` را اجرا می‌کند که پوشه‌های وضعیت نسخه ۳ زیر `.astack/` را به `.gitignore` موجود اضافه می‌کند. بعد قدم‌های [روشن کردن دستیار همیشه‌روشن](#روشن-کردن-دستیار-همیشهروشن-نسخه-۳) را انجام دهید. جزئیات: [ارتقای هسته](documentation/Upgrade.md) و [CHANGELOG](CHANGELOG.md).

## سازمان خودگردان
AStack مالکش را بین گفتگوها به یاد می‌آورد، برای هر درخواست کوچک‌ترین تیم لازم را می‌سازد، با ابزارهای واقعی روی نرم‌افزار و وب‌سایت‌ها کار می‌کند، پیش از هر اقدام برگشت‌ناپذیر متوقف می‌شود، نتیجه را راستی‌آزمایی می‌کند، همه‌چیز را ممیزی می‌کند و از تجربه یاد می‌گیرد.

```bash
node bin/astack.mjs standup                                    # کپسول هویت، مأموریت‌ها، تأییدها و کارهای پس‌زمینه
node bin/astack.mjs ask "وضعیت پرونده آکمه چیست؟"                 # تحلیل درخواست و برنامه اجرا
node bin/astack.mjs ask "اظهارنامه را ثبت کن" --dry-run           # توضیح کامل، بدون هیچ اثر بیرونی
node bin/astack.mjs context map "مغایرت‌گیری فاکتورها"             # نقشه فضای کاری در بودجه توکن
node bin/astack.mjs memory search "حسابدار شرکت آکمه"             # بازیابی زمان‌مند حافظه
node bin/astack.mjs search "قرارداد اجاره تمدید"                   # جست‌وجو در حافظه، گفتگوهای قبلی و گزارش‌ها
node bin/astack.mjs schedule add "پایش پورتال" --kind http-check --every 10m --url https://example.com
node bin/astack.mjs signal create "واتساپ" --source whatsapp      # هوک ورودی برای دریافت پیام
node bin/astack.mjs browser login owner --url https://portal.example.gov
node bin/astack.mjs approval pending                            # تصمیم‌های در انتظار شما
```

مستندات کامل: [Autonomous Organization](documentation/Autonomous-Organization.md) و [CLI Reference](documentation/CLI.md). اجزای سازنده در بخش [امکانات](#امکانات) آمده‌اند.

## دامنه‌های کاری
رجیستری دامنه هر درخواست را — فارسی یا انگلیسی — به دپارتمان‌ها، ورک‌فلو و نقشه تیم مناسب هدایت می‌کند: نرم‌افزار، حقوقی، مالی، حسابداری، مالیاتی، بازاریابی، عملیات، منابع انسانی، تحقیق و کسب‌وکار. ببینید: [دپارتمان‌ها](documentation/Departments.md) و [نقش‌ها](documentation/Roles.md) (۳۳ دپارتمان، ۲۱۹ نقش تخصصی).

## تیم‌ها، ایجنت‌ها و رهبری
- `astack team` — تشکیل و مدیریت تیم‌های تخصصی از روی نقشه هر دامنه
- `astack agent` — ساخت ایجنت، زمان‌بندی مأموریت‌های یک‌باره یا تکرارشونده، صدور دستور کار و ثبت گزارش
- `astack lead` — لایه رهبری: برنامه‌ریزی، تشکیل تیم، سپردن کارهای پروژه، گزارش وضعیت و بازبینی خروجی‌ها
- `astack board` — اجرای کارت‌ها برای ایجنت‌ها و تیم‌ها بدون حضور شما، با تلاش دوباره و بازبین (نسخه ۳)

راهنمای کامل: [دامنه‌ها، تیم‌ها، ایجنت‌ها و رهبری](documentation/Orchestration.md).

## تحویل پروژه
موتور تحویل، پروژه‌ها را مانند یک تیم تحویل حرفه‌ای مدیریت می‌کند: چرخه مرحله‌بندی‌شده با دروازه‌های عبور، تخمین PERT، بک‌لاگ رتبه‌بندی‌شده با WSJF، بورد کانبان با محدودیت WIP، برنامه‌ریزی اسپرینت بر اساس سرعت واقعی، دفتر ریسک امتیازدهی‌شده، پیش‌بینی اتمام مونت‌کارلو، مدیریت ارزش کسب‌شده (EVM)، امتیاز سلامت شفاف و پیشنهاد اقدام بعدی. قالب‌های آماده برای نرم‌افزار، قابلیت هوش مصنوعی، MVP استارتاپ، کمپین بازاریابی، پرونده حقوقی، اظهارنامه مالیاتی، بستن حساب و حسابرسی مالی. ببینید: [مدیریت پروژه](documentation/Project-Management.md).

## ارتقای هسته
پروژه‌هایی که AStack را درون خود دارند با `astack upgrade` (یا `astack update`) خودشان را به‌روز می‌کنند. نصب‌های قدیمی‌تر که موتور ارتقا را ندارند، فایل تکِ `scripts/astack-upgrade.mjs` را داخل پروژه کپی و یک بار اجرا می‌کنند — آخرین هسته را می‌گیرد و با منطق جدید ارتقا می‌دهد؛ در حالی که `.astack/`، `memory/`، پلاگین‌ها، knowledge packها و هر مسیر ثبت‌شده در `upgrade.keep` دست‌نخورده می‌مانند. ببینید: [ارتقای هسته](documentation/Upgrade.md) و [راهنمای مهاجرت](documentation/Migration-Guide.md).

## مستندات
مجموعه کامل در [`documentation/`](documentation/README.md) قرار دارد — مفاهیم، عملیات، راهنمای توسعه، امنیت و راهنمای کامل فارسی مالک ([fa-guide.html](documentation/fa-guide.html)). تازه در نسخه ۳: [اجراکننده و پردازش پس‌زمینه](documentation/Runner-and-Daemon.md)، [پیام‌رسان](documentation/Gateway.md)، [کنسول آرامین](documentation/Aramin-Console.md)، [جست‌وجو](documentation/Search.md)، [مرکز مهارت](documentation/Skill-Hub.md)، [تابلوی کار، محیط ایزوله، گاوصندوق و A2A](documentation/Board-Sandbox-Vault.md).
