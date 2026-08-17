# Workflow تحویل پروژه (Project Delivery)

## سیاست زبان
این workflow باید `../system/language-policy.md` را رعایت کند. توضیح، گزارش و تحلیل فارسی است؛ commandها و دارایی‌های نرم‌افزاری انگلیسی می‌مانند.

## فرمان
`astack project`

## هدف
هر کار قابل‌توجه به‌صورت یک پروژه با چرخه حیات کامل مدیریت شود تا مانند حرفه‌ای‌ترین تیم‌های دنیا برنامه‌ریزی، پایش و «تکمیل» شود — نه فقط شروع.

## مراحل
1. **Charter** — با `astack project init` پروژه ساخته می‌شود (در صورت نیاز با `--template`)؛ نتیجه و معیارهای موفقیت با `astack project charter` ثبت می‌شود.
2. **Decomposition** — کارها با `astack project add` به epic/story/task با تخمین سه‌نقطه‌ای PERT، وابستگی و امتیاز WSJF شکسته می‌شوند؛ `astack project scaffold --goal` ساختار اولیه را از روی هدف می‌سازد.
3. **Baseline** — با عبور از دروازه planning (`astack project advance`) خط مبنا ثبت می‌شود؛ از این لحظه EVM و scope creep قابل‌سنجش است.
4. **Sprint Execution** — `astack project sprint <id> plan` بر اساس سرعت تیم و رتبه WSJF آیتم انتخاب می‌کند؛ برد کانبان با سقف WIP جریان را کنترل می‌کند و `astack project done --effort` دقت تخمین را ثبت می‌کند.
5. **Monitoring** — `astack project status` سلامت RAG با دلایل شفاف، SPI/CPI، پیش‌بینی مونت‌کارلو و مسیر بحرانی را می‌دهد؛ `astack project next` بهترین اقدام بعدی را پیشنهاد می‌کند؛ `astack project digest` خلاصه روزانه می‌سازد.
6. **Closure** — بستن اسپرینت آخر، ثبت retrospective، عبور از دروازه closing و closed؛ ضریب کالیبراسیون تخمین به حافظه سازمانی نوشته می‌شود تا پروژه بعدی دقیق‌تر تخمین بخورد.

## دروازه‌های مرحله‌ای
هر عبور فاز فقط با برقراری معیارهای محاسبه‌شده انجام می‌شود؛ در صورت رد شدن، معیارهای برقرارنشده به فارسی چاپ می‌شوند.

## معیار تکمیل
- همه آیتم‌های must تحویل یا رسماً از دامنه خارج شده‌اند.
- retrospective ثبت شده و اقدام‌های آن در حافظه سازمانی است.
- گزارش نهایی با `astack project report` ذخیره شده است.
