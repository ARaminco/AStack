# AStack Enterprise

**زبان‌ها:** [English](README.md) · فارسی · [العربية](README.ar.md) · [Türkçe](README.tr.md) — **مستندات:** [فهرست مستندات](documentation/README.md)

AStack Enterprise یک سیستم‌عامل هوش مصنوعی ماژولار است که به‌طور هم‌تراز داخل Claude Code و OpenAI Codex اجرا می‌شود — یک قرارداد، یک حافظه و یک دفترچه رویداد مشترک — و برای ChatGPT و رانتایم‌های آینده نیز باز است. این سیستم هر نوع کاری را مدیریت می‌کند — توسعه نرم‌افزار، پرونده‌های حقوقی، امور مالی، مالیاتی، حسابداری، بازاریابی، عملیات، منابع انسانی، تحقیق و استراتژی کسب‌وکار — با تشکیل تیم‌های تخصصی، ساخت ایجنت‌ها و تفویض مأموریت‌های زمان‌بندی‌شده زیر نظر لایه رهبری.

## رانتایم
- رانتایم‌ها: Claude Code و Codex به‌صورت هم‌تراز ([مغز مشترک](documentation/Codex-and-Claude-Code.md)، [چرخه کار Claude Code](documentation/Claude-Code.md))
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
در پروژه‌ای که AStack دارد: `node bin/astack.mjs setup --update`.

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


## سازمان خودگردان
AStack مالکش را بین گفتگوها به یاد می‌آورد، برای هر درخواست کوچک‌ترین تیم لازم را می‌سازد، با ابزارهای واقعی روی نرم‌افزار و وب‌سایت‌ها کار می‌کند، پیش از هر اقدام برگشت‌ناپذیر متوقف می‌شود، نتیجه را راستی‌آزمایی می‌کند، همه‌چیز را ممیزی می‌کند و از تجربه یاد می‌گیرد.

```bash
node bin/astack.mjs standup                                    # کپسول هویت، مأموریت‌ها، تأییدها و کارهای پس‌زمینه
node bin/astack.mjs ask "وضعیت پرونده آکمه چیست؟"                 # تحلیل درخواست و برنامه اجرا
node bin/astack.mjs ask "اظهارنامه را ثبت کن" --dry-run           # توضیح کامل، بدون هیچ اثر بیرونی
node bin/astack.mjs context map "مغایرت‌گیری فاکتورها"             # نقشه فضای کاری در بودجه توکن
node bin/astack.mjs memory search "حسابدار شرکت آکمه"             # بازیابی زمان‌مند حافظه
node bin/astack.mjs schedule add "پایش پورتال" --kind http-check --every 10m --url https://example.com
node bin/astack.mjs signal create "واتساپ" --source whatsapp      # هوک ورودی برای دریافت پیام
node bin/astack.mjs browser login owner --url https://portal.example.gov
node bin/astack.mjs approval pending                            # تصمیم‌های در انتظار شما
```

### چه چیزی اضافه شده است
- **حافظه چندوجهی زمان‌مند** — دوازده وجه حافظه، جایگزینی به‌جای بازنویسی، تجمیع شبانه
- **موتور زمینه** — نقشه فضای کاری، ایندکس نمادها و گراف رکوردهای دامنه‌ای در بودجه توکن مشخص
- **گراف دانش** — اشخاص، شرکت‌ها، پرونده‌ها و حساب‌ها و رابطه‌شان در طول زمان
- **یادگیری خودکار** — کار تکراری پس از سه اجرا به یک skill نسخه‌دار و مستند تبدیل می‌شود
- **مرورگر داخلی** — ورود ماندگار، کار واقعی با فرم‌ها، شواهد زنجیره‌ای و توقف پیش از ثبت نهایی
- **زمان‌بند و هوک‌ها** — پایش پس‌زمینه و رویدادهای ورودی که خودشان مأموریت می‌سازند
- **لایه اعتماد** — سطوح اختیار، رسید تأیید، ردّ ممیزی و بروکر اعتبارنامه

مستندات کامل: [Autonomous Organization](documentation/Autonomous-Organization.md) و [CLI Reference](documentation/CLI.md).

## دامنه‌های کاری
رجیستری دامنه هر درخواست را — فارسی یا انگلیسی — به دپارتمان‌ها، ورک‌فلو و نقشه تیم مناسب هدایت می‌کند: نرم‌افزار، حقوقی، مالی، حسابداری، مالیاتی، بازاریابی، عملیات، منابع انسانی، تحقیق و کسب‌وکار. ببینید: [دپارتمان‌ها](documentation/Departments.md) و [نقش‌ها](documentation/Roles.md) (۳۳ دپارتمان، ۲۱۹ نقش تخصصی).

## تیم‌ها، ایجنت‌ها و رهبری
- `astack team` — تشکیل و مدیریت تیم‌های تخصصی از روی نقشه هر دامنه
- `astack agent` — ساخت ایجنت، زمان‌بندی مأموریت‌های یک‌باره یا تکرارشونده، صدور دستور کار و ثبت گزارش
- `astack lead` — لایه رهبری: برنامه‌ریزی، تشکیل تیم، تفویض کارهای پروژه، گزارش وضعیت و بازبینی خروجی‌ها

راهنمای کامل: [دامنه‌ها، تیم‌ها، ایجنت‌ها و رهبری](documentation/Orchestration.md).

## تحویل پروژه
موتور تحویل، پروژه‌ها را مانند یک تیم تحویل حرفه‌ای مدیریت می‌کند: چرخه مرحله‌بندی‌شده با دروازه‌های عبور، تخمین PERT، بک‌لاگ رتبه‌بندی‌شده با WSJF، بورد کانبان با محدودیت WIP، برنامه‌ریزی اسپرینت بر اساس سرعت واقعی، دفتر ریسک امتیازدهی‌شده، پیش‌بینی اتمام مونت‌کارلو، مدیریت ارزش کسب‌شده (EVM)، امتیاز سلامت شفاف و پیشنهاد اقدام بعدی. قالب‌های آماده برای نرم‌افزار، قابلیت هوش مصنوعی، MVP استارتاپ، کمپین بازاریابی، پرونده حقوقی، اظهارنامه مالیاتی، بستن حساب و حسابرسی مالی. ببینید: [مدیریت پروژه](documentation/Project-Management.md).

## ارتقای هسته
پروژه‌هایی که AStack را درون خود دارند با `astack upgrade` خودشان را به‌روز می‌کنند. نصب‌های قدیمی‌تر که موتور ارتقا را ندارند، فایل تکِ `scripts/astack-upgrade.mjs` را داخل پروژه کپی و یک بار اجرا می‌کنند — آخرین هسته را می‌گیرد و با منطق جدید ارتقا می‌دهد؛ در حالی که `.astack/`، `memory/`، پلاگین‌ها، knowledge packها و هر مسیر ثبت‌شده در `upgrade.keep` دست‌نخورده می‌مانند. ببینید: [ارتقای هسته](documentation/Upgrade.md) و [راهنمای مهاجرت](documentation/Migration-Guide.md).

## مستندات
مجموعه کامل در [`documentation/`](documentation/README.md) قرار دارد — مفاهیم، عملیات، راهنمای توسعه، امنیت و راهنمای کامل فارسی مالک ([fa-guide.html](documentation/fa-guide.html)).
