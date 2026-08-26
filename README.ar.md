# AStack Enterprise

**اللغات:** [English](README.md) · [فارسی](README.fa.md) · العربية · [Türkçe](README.tr.md) — **الوثائق:** [فهرس الوثائق](documentation/README.md)

AStack Enterprise هو نظام تشغيل ذكاء اصطناعي معياري مصمم للعمل أساسًا داخل Claude Code مع بقائه متوافقًا مع OpenAI Codex وChatGPT وبيئات تشغيل الوكلاء المستقبلية. يدير أي نوع من الأعمال — تطوير البرمجيات، القضايا القانونية، الشؤون المالية، الضرائب، المحاسبة، التسويق، العمليات، الموارد البشرية، البحث واستراتيجية الأعمال — عبر تشكيل فرق متخصصة، وإنشاء وكلاء، وتفويض مهام مجدولة تحت طبقة قيادة.

## بيئة التشغيل
- بيئة التشغيل الأساسية: Claude Code ([كيف يشغّل AStack](documentation/Claude-Code.md))
- التواصل مع المالك: بالفارسية — الشيفرة والوثائق التقنية: بالإنجليزية
- المعمارية: طبقية، قابلة للتوسعة بالإضافات، مستقلة عن المزوّد، واعية بالمجالات ([التفاصيل](documentation/Architecture.md))

## البدء السريع
```bash
npm test
node bin/astack.mjs doctor
node bin/astack.mjs domain detect "tax filing for VAT"
node bin/astack.mjs lead plan "legal case for a property contract"
node bin/astack.mjs lead team "legal case for a property contract" --name legal-case-team
node bin/astack.mjs project init "Contract Dispute" --template legal-case
node bin/astack.mjs lead delegate contract-dispute --team legal-case-team
node bin/astack.mjs agent run-due
node bin/astack.mjs lead standup
```
المزيد في [دليل التثبيت](documentation/Installation.md) و[مرجع الأوامر](documentation/API.md).

## المنظمة ذاتية التشغيل
يتذكّر AStack مالكه عبر المحادثات، ويشكّل أصغر فريق خبراء تحتاجه كل مهمة، ويشغّل البرمجيات والمواقع عبر أدوات حقيقية، ويتوقف قبل أي إجراء لا يمكن التراجع عنه، ويتحقق من النتيجة، ويسجّلها للتدقيق، ويتعلّم منها.

```bash
node bin/astack.mjs standup
node bin/astack.mjs ask "what is the status of this invoice?"
node bin/astack.mjs ask "file the quarterly vat return" --dry-run
node bin/astack.mjs context map "invoice reconciliation"
node bin/astack.mjs memory search "the accountant of Acme"
node bin/astack.mjs schedule add "portal" --kind http-check --every 10m --url https://example.com
node bin/astack.mjs signal create "whatsapp inbox" --source whatsapp
node bin/astack.mjs browser login owner --url https://portal.example.gov
node bin/astack.mjs approval pending
```

اقرأ التفاصيل في [Autonomous Organization](documentation/Autonomous-Organization.md)، وراجع جدول حالة الميزات فيه لمعرفة ما هو منفَّذ فعليًا وما هو جاهز للربط فقط.

### ما الذي أُضيف
- **ذاكرة متعددة الأوجه وزمنية** — اثنا عشر وجهًا للذاكرة، واستبدال الحقائق بدل استبدالها الكامل، وتجميع ليلي ([التفاصيل](documentation/Memory-OS.md))
- **محرّك السياق** — خريطة مساحة العمل وفهرس الرموز ورسم بياني لسجلات المجال ضمن ميزانية رموز محددة ([التفاصيل](documentation/Context-Engine.md))
- **رسم بياني للمعرفة** — الأشخاص والشركات والقضايا والحسابات وعلاقاتها عبر الزمن ([التفاصيل](documentation/Knowledge-Graph.md))
- **محرّك التعلّم** — العمل المتكرر يتحول إلى مهارة موثّقة ومُصدَّرة بنسخ ([التفاصيل](documentation/Learning-Engine.md))
- **متصفح داخلي** — جلسات دخول دائمة، وعمل حقيقي على النماذج، وأدلة مترابطة بالتجزئة، وتوقف قبل الإرسال النهائي ([التفاصيل](documentation/Browser-Operator.md))
- **المجدول والخطافات** — مراقبة في الخلفية وأحداث واردة تُنشئ مهامًا بنفسها ([التفاصيل](documentation/Scheduler-and-Signals.md))
- **طبقة الثقة** — مستويات صلاحية، وإيصالات موافقة، وسجل تدقيق، ووسيط اعتماديات ([التفاصيل](documentation/Security-and-Authority.md))

## مجالات العمل
يوجّه سجل المجالات كل طلب — بالفارسية أو الإنجليزية — إلى الأقسام وسير العمل ومخطط الفريق المناسب: البرمجيات، القانون، المالية، المحاسبة، الضرائب، التسويق، العمليات، الموارد البشرية، البحث، والأعمال. انظر: [الأقسام](documentation/Departments.md) و[الأدوار](documentation/Roles.md) (33 قسمًا، 219 دورًا متخصصًا).

## الفرق والوكلاء والقيادة
- `astack team` — تشكيل الفرق متعددة التخصصات من مخططات المجالات وإدارتها
- `astack agent` — إنشاء الوكلاء، جدولة مهام لمرة واحدة أو متكررة، إصدار أوامر العمل وتسجيل التقارير
- `astack lead` — طبقة القيادة: التخطيط، تشكيل الفريق، تفويض أعمال المشروع، متابعة الحالة ومراجعة المخرجات

الدليل الكامل: [المجالات والفرق والوكلاء والقيادة](documentation/Orchestration.md).

## تسليم المشاريع
يدير محرك التسليم المشاريع كفريق تسليم محترف: دورة حياة ببوابات مرحلية، تقديرات PERT، قائمة أعمال مرتبة بـWSJF، لوحة كانبان بحدود WIP، تخطيط سباقات بالسرعة الفعلية، سجل مخاطر مُقيَّم، توقعات إنجاز مونت كارلو، إدارة القيمة المكتسبة (EVM)، درجة صحة قابلة للتفسير، وتوصيات بالخطوة التالية. قوالب جاهزة للبرمجيات، وميزات الذكاء الاصطناعي، وMVP للشركات الناشئة، والحملات التسويقية، والقضايا القانونية، والإقرارات الضريبية، والإقفال المحاسبي، والتدقيق المالي. انظر: [إدارة المشاريع](documentation/Project-Management.md).

## ترقية النواة
المشاريع التي تضم AStack تُحدِّث نفسها بالأمر `astack upgrade`. أما التثبيتات الأقدم التي تسبق محرك الترقية فتنسخ الملف الواحد `scripts/astack-upgrade.mjs` إلى المشروع وتشغّله مرة واحدة — يجلب أحدث نواة ويطبّق منطق الترقية الجديد مع الحفاظ الكامل على `.astack/` و`memory/` والإضافات وحزم المعرفة وأي مسار مسجّل في `upgrade.keep`. انظر: [ترقية النواة](documentation/Upgrade.md) و[دليل الترحيل](documentation/Migration-Guide.md).

## الوثائق
المجموعة الكاملة في [`documentation/`](documentation/README.md) — المفاهيم، والتشغيل، وأدلة التوسعة، والأمان، والدليل الفارسي الكامل للمالك ([fa-guide.html](documentation/fa-guide.html)).
