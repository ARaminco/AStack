# AStack Enterprise

**اللغات:** [English](README.md) · [فارسی](README.fa.md) · العربية · [Türkçe](README.tr.md) — **الوثائق:** [فهرس الوثائق](documentation/README.md)

AStack Enterprise نظام تشغيل ذكاء اصطناعي معياري يعمل بشكل متكافئ داخل Claude Code وOpenAI Codex — عقد واحد وذاكرة واحدة وسجل أحداث واحد مشترك — ويبقى منفتحًا على ChatGPT وبيئات تشغيل الوكلاء المستقبلية. يدير أي نوع من الأعمال — تطوير البرمجيات، القضايا القانونية، الشؤون المالية، الضرائب، المحاسبة، التسويق، العمليات، الموارد البشرية، البحث واستراتيجية الأعمال — عبر تشكيل فرق متخصصة، وإنشاء وكلاء، وتفويض مهام مجدولة تحت طبقة قيادة. ومنذ الإصدار 3.0 أصبح **يعمل دائمًا وفي جيبك**: منفّذ آلي وعملية خلفية واحدة يواصلان المهام والوظائف المجدولة والخطافات حتى في غياب أي شخص أمام الجهاز؛ وتوجّه إليه الأوامر وتوافق على خطواته غير القابلة للتراجع من تيليجرام أو واتساب؛ و**آرامين**، وهي لوحة تحكم محلية قابلة للتثبيت كتطبيق، تعرض كل موافقة ومهمة وتشغيل وسجل تدقيق. وكل قدرة جديدة تعمل داخل نموذج الثقة نفسه: سقوف الصلاحية وإيصالات الموافقة وسجل التدقيق.

## الميزات

**بيئات التشغيل والتكامل**
- Claude Code وCodex بشكل متكافئ على عقد واحد وذاكرة واحدة وسجل واحد ([الوثيقة](documentation/Codex-and-Claude-Code.md))
- الرسم البياني للشيفرة Graphify ضمن ميزانيات رموز AStack ([الوثيقة](documentation/Graphify.md))
- نقطة A2A: يمكن لوكلاء آخرين طلب خطة من AStack، على الجهاز المحلي فقط، بمصادقة برمز، وتكتفي بالتخطيط افتراضيًا ([الوثيقة](documentation/Board-Sandbox-Vault.md#a2a-endpoint-interop-enginea2a-servermjs)) — *جديد في 3.0*

**يعمل دائمًا** — *جديد في 3.0*
- **المنفّذ (runner)** — ينفّذ `astack run` هدفًا أو مهمة دون حضورك عبر Claude Code بلا واجهة، أو `codex exec`، أو نموذج Ollama محلي، مع ميزانية يومية وأخرى لكل تشغيل، وحد للتشغيل المتزامن، وسقف صلاحية يُفرض داخل الأدوات نفسها ([الوثيقة](documentation/Runner-and-Daemon.md))
- **العملية الخلفية (daemon)** — عملية واحدة تشرف على طابور المنفّذ والمجدول ومستمع الخطافات والبوابة وإعادة فهرسة البحث واللوحة ولوحة التحكم، وتعيد تشغيل ما يتعطل؛ وتُثبَّت كمهمة في Task Scheduler على ويندوز، أو LaunchAgent على macOS، أو خدمة مستخدم systemd على لينكس ([الوثيقة](documentation/Runner-and-Daemon.md#daemon-daemon-engine))
- **اللوحة (board)** — كانبان دائم متعدد الوكلاء مع تبعيات وإعادة محاولة ومسار مراجع مستقل وتوجيه أثناء العمل ([الوثيقة](documentation/Board-Sandbox-Vault.md#board-board-engine))

**في جيبك** — *جديد في 3.0*
- **البوابة (gateway)** — وجّه AStack من تيليجرام أو واتساب (عبر بوابة HTTP متوافقة مع wapi، أو جسر «الجهاز المرتبط» الخاص بـ AStack، أو Cloud API من Meta)؛ قوائم سماح للمالك مع عدة حسابات لكل قناة؛ وافق بـ «بفرست» أو "approve" وارفض بـ «نه» أو "deny"؛ وتحويل الرسائل الصوتية الفارسية إلى نص محليًا ([الوثيقة](documentation/Gateway.md))
- **لوحة تحكم آرامين** — تطبيق ويب محلي قابل للتثبيت (PWA) للموافقات والمهام والذاكرة والتشغيلات والوظائف والتدقيق والمهارات واللوحة وحالة النظام؛ على الجهاز المحلي فقط، بتسجيل دخول برمز، وبالفارسية افتراضيًا ([الوثيقة](documentation/Aramin-Console.md))

**الذاكرة والاسترجاع**
- **ذاكرة متعددة الأوجه وزمنية** — اثنا عشر وجهًا، واستبدال الحقائق بنسخ جديدة بدل الكتابة فوقها، وتجميع ليلي ([الوثيقة](documentation/Memory-OS.md))
- **البحث** — فهرس واحد يفهم الفارسية يغطي الذاكرة وجلسات Claude Code وCodex السابقة والتقارير والمهارات والمهام: SQLite FTS5 مع تضمينات Ollama الاختيارية، وملف حتمي لوصف المالك ([الوثيقة](documentation/Search.md)) — *جديد في 3.0*
- **محرّك السياق** — خريطة مساحة العمل وفهرس الرموز ورسم بياني لسجلات المجال ضمن ميزانية رموز محددة ([الوثيقة](documentation/Context-Engine.md))
- **رسم بياني للمعرفة** — الأشخاص والشركات والقضايا والحسابات وعلاقاتها عبر الزمن ([الوثيقة](documentation/Knowledge-Graph.md))

**المهارات والتعلّم**
- **محرّك التعلّم** — العمل المتكرر يتحول إلى مهارة موثّقة ذات إصدارات ([الوثيقة](documentation/Learning-Engine.md))
- **مركز المهارات (skill hub)** — استيراد مهارات `SKILL.md` إلى حزم مساعدة يفحصها ماسح أمني ثابت وتُرتَّب دائمًا تحت المهارات المدمجة؛ مع حزمة Hermes Agent (211 مهارة بترخيص MIT)؛ المهارات عالية الخطورة لا تُختار تلقائيًا أبدًا ومهارتان محظورتان كليًا؛ ومنسّق يوصي بالإبقاء أو التحسين أو الإحالة إلى التقاعد ([الوثيقة](documentation/Skill-Hub.md)) — *جديد في 3.0*

**عمل حقيقي بأمان**
- **المهام** — دائمة وقابلة للاستئناف، مع نقاط توقف للموافقة وتشغيل تجريبي وإعادة تشغيل ([الوثيقة](documentation/Autonomous-Organization.md))
- **متصفح داخلي** — جلسات دخول دائمة، وعمل حقيقي على النماذج، وأدلة مترابطة، وتوقف قبل الإرسال النهائي ([الوثيقة](documentation/Browser-Operator.md))
- **المجدول والخطافات** — مراقبة في الخلفية وأحداث واردة تُنشئ مهامًا أو تضع تشغيلات في طابور المنفّذ ([الوثيقة](documentation/Scheduler-and-Signals.md))
- **بيئة معزولة (sandbox)** — تنفيذ الأوامر داخل Docker: بلا شبكة، ونظام ملفات للقراءة فقط، والأسرار مخفية ([الوثيقة](documentation/Board-Sandbox-Vault.md#sandbox-sandbox-engine)) — *جديد في 3.0*

**الثقة**
- مستويات صلاحية من L0 إلى L5، وإيصالات موافقة، وسجل تدقيق، ووسيط اعتماديات ([الوثيقة](documentation/Security-and-Authority.md))
- خزائن أسرار نظام التشغيل (DPAPI على ويندوز؛ ومحوّلات Keychain على macOS وSecret Service على لينكس وBitwarden و1Password) وحارس يمحو كل سر مُستخدَم من جميع المخرجات ([الوثيقة](documentation/Board-Sandbox-Vault.md#vault-backends-trust-enginevaultmjs)) — *جديد في 3.0*

**التنظيم والتسليم**
- عشرة مجالات عمل و33 قسمًا و219 دورًا، مع الفرق والوكلاء وطبقة القيادة ([الوثيقة](documentation/Orchestration.md))
- تسليم المشاريع ببوابات مرحلية مع PERT وWSJF وحدود WIP وتوقعات مونت كارلو وEVM ([الوثيقة](documentation/Project-Management.md))
- ترقيات آمنة للنواة مع نسخ احتياطية ودمج ثلاثي لتخصيصات المالك وتراجع تلقائي ([الوثيقة](documentation/Upgrade.md))

## بيئة التشغيل
- بيئات التشغيل: Claude Code وCodex بشكل متكافئ ([كيف يتشاركان عقلًا واحدًا](documentation/Codex-and-Claude-Code.md)، [دورة عمل Claude Code](documentation/Claude-Code.md))؛ والتشغيل دون حضور عبر [المنفّذ](documentation/Runner-and-Daemon.md)
- الرسم البياني للشيفرة: [Graphify](documentation/Graphify.md) ضمن ميزانيات رموز AStack لكلتا البيئتين (`node bin/astack.mjs graphify setup`)
- العقد المشترك: `AGENTS.md` (يقرؤه Codex مباشرة ويستورده `CLAUDE.md`)؛ ربط البيئتين: `node bin/astack.mjs interop sync`
- التواصل مع المالك: بالفارسية — الشيفرة والوثائق التقنية: بالإنجليزية
- المعمارية: طبقية، قابلة للتوسعة بالإضافات، مستقلة عن المزوّد، واعية بالمجالات ([التفاصيل](documentation/Architecture.md))

## التثبيت في أي مشروع
مشروع جديد أو قديم، مع نواة AStack أو بدونها — أمر واحد يجهّز النواة وClaude Code وCodex وGraphify والفهرس ومهارة `astack-setup` العامة (بعدها يكفي أن تقول لأي من البيئتين "install / set up"):
```bash
git clone --depth 1 https://github.com/ARaminco/AStack.git ~/.astack/core   # أو: git -C ~/.astack/core pull
node ~/.astack/core/bin/astack.mjs setup --target /path/to/project
```
لتحديث أي مشروع قل لـ Claude Code أو Codex "update AStack" (أو «آپدیت کن»)، أو شغّل [مسار التحديث](documentation/Upgrade.md) مباشرة: `node ~/.astack/core/bin/astack.mjs update --target /path/to/project`.

## البدء السريع
```bash
npm test
node bin/astack.mjs doctor
node bin/astack.mjs interop sync && node bin/astack.mjs interop status
node bin/astack.mjs domain detect "tax filing for VAT"
node bin/astack.mjs lead plan "legal case for a property contract"
node bin/astack.mjs lead team "legal case for a property contract" --name legal-case-team
node bin/astack.mjs project init "Contract Dispute" --template legal-case
node bin/astack.mjs lead delegate contract-dispute --team legal-case-team
node bin/astack.mjs agent run-due
node bin/astack.mjs lead standup
```
المزيد في [دليل التثبيت](documentation/Installation.md) و[مرجع الأوامر](documentation/API.md).

### تشغيل المساعد الدائم (3.0)
كل محرّكات الإصدار 3.0 متوقفة أو للقراءة فقط حتى تشغّلها بنفسك. أربع خطوات:

```bash
# 1. المنفّذ: اسمح مرة واحدة بتشغيل Claude Code دون حضور، ثم اعرض تشغيلًا تجريبيًا
node bin/astack.mjs schedule policy allow-command claude
node bin/astack.mjs runner engines
node bin/astack.mjs run "summarize today's open missions" --dry-run

# 2. العملية الخلفية: عملية واحدة للمنفّذ والمجدول والخطافات والبوابة والبحث واللوحة ولوحة التحكم
node bin/astack.mjs daemon start
node bin/astack.mjs daemon status
node bin/astack.mjs daemon install-service --dry-run   # راجع الخطة ثم شغّلها بدون --dry-run لتبدأ مع تسجيل الدخول

# 3. لوحة آرامين: تفتح المتصفح مسجَّل الدخول ما دامت العملية الخلفية تعمل
node bin/astack.mjs console open                        # بدون العملية الخلفية: astack console start --open

# 4. بوابة تيليجرام: أنشئ بوتًا عبر @BotFather أولًا
node bin/astack.mjs secret vault set credential://telegram/bot           # الصق رمز البوت في الحقل المخفي
node bin/astack.mjs gateway owner add telegram <معرّف تيليجرام الرقمي الخاص بك>
```

ثم فعّل البوابة في `astack.config.yaml` وأعد تشغيل العملية الخلفية:

```yaml
gateway:
  enabled: true
  channels:
    telegram:
      enabled: true
```

```bash
node bin/astack.mjs gateway test telegram     # فحص صحة للقراءة فقط
node bin/astack.mjs daemon stop && node bin/astack.mjs daemon start
```

أرسل رسالة إلى البوت: تتحول إلى طلب للمنفّذ. تصل طلبات الموافقة بالقيم الدقيقة ورمز من أربعة محارف؛ رُدّ على الطلب بـ «بفرست» أو "approve" (أو «نه» / "deny"). قنوات واتساب والرسائل الصوتية وكل القواعد في [دليل البوابة](documentation/Gateway.md).

## الترقية إلى 3.0
الإصدار 3.0 إضافي بالكامل: كل أمر وصيغة ملف واختبار من 2.5.1 يعمل كما هو، وكل محرّك جديد متوقف أو للقراءة فقط حتى يُضبط. حدّث كالمعتاد:

```bash
node bin/astack.mjs update            # أو قل لـ Claude Code / Codex «آپدیت کن»
```

يجلب التحديث المحرّكات الجديدة ومجلد `skill-packs/`، ولا يمسّ `astack.config.yaml` (أقسام 3.0 تأتي كقيم افتراضية معلّقة)، ويشغّل الترحيل `2026.8-ignore-v3-state` الذي يضيف مجلدات حالة 3.0 تحت `.astack/` إلى ملف `.gitignore` الموجود. ثم اتبع [تشغيل المساعد الدائم](#تشغيل-المساعد-الدائم-30). التفاصيل: [ترقية النواة](documentation/Upgrade.md) و[CHANGELOG](CHANGELOG.md).

## المنظمة ذاتية التشغيل
يتذكّر AStack مالكه عبر المحادثات، ويشكّل أصغر فريق خبراء تحتاجه كل مهمة، ويشغّل البرمجيات والمواقع عبر أدوات حقيقية، ويتوقف قبل أي إجراء لا يمكن التراجع عنه، ويتحقق من النتيجة، ويسجّلها للتدقيق، ويتعلّم منها.

```bash
node bin/astack.mjs standup
node bin/astack.mjs ask "what is the status of this invoice?"
node bin/astack.mjs ask "file the quarterly vat return" --dry-run
node bin/astack.mjs context map "invoice reconciliation"
node bin/astack.mjs memory search "the accountant of Acme"
node bin/astack.mjs search "lease renewal contract"
node bin/astack.mjs schedule add "portal" --kind http-check --every 10m --url https://example.com
node bin/astack.mjs signal create "whatsapp inbox" --source whatsapp
node bin/astack.mjs browser login owner --url https://portal.example.gov
node bin/astack.mjs approval pending
```

اقرأ التفاصيل في [Autonomous Organization](documentation/Autonomous-Organization.md)، وراجع جدول حالة الميزات فيه لمعرفة ما هو منفَّذ فعليًا وما هو جاهز للربط فقط. مكوّنات النظام مذكورة في [الميزات](#الميزات).

## مجالات العمل
يوجّه سجل المجالات كل طلب — بالفارسية أو الإنجليزية — إلى الأقسام وسير العمل ومخطط الفريق المناسب: البرمجيات، القانون، المالية، المحاسبة، الضرائب، التسويق، العمليات، الموارد البشرية، البحث، والأعمال. انظر: [الأقسام](documentation/Departments.md) و[الأدوار](documentation/Roles.md) (33 قسمًا، 219 دورًا متخصصًا).

## الفرق والوكلاء والقيادة
- `astack team` — تشكيل الفرق متعددة التخصصات من مخططات المجالات وإدارتها
- `astack agent` — إنشاء الوكلاء، جدولة مهام لمرة واحدة أو متكررة، إصدار أوامر العمل وتسجيل التقارير
- `astack lead` — طبقة القيادة: التخطيط، تشكيل الفريق، تفويض أعمال المشروع، متابعة الحالة ومراجعة المخرجات
- `astack board` — تشغيل البطاقات للوكلاء والفرق دون حضور، مع إعادة المحاولة ومسار المراجع (3.0)

الدليل الكامل: [المجالات والفرق والوكلاء والقيادة](documentation/Orchestration.md).

## تسليم المشاريع
يدير محرك التسليم المشاريع كفريق تسليم محترف: دورة حياة ببوابات مرحلية، تقديرات PERT، قائمة أعمال مرتبة بـWSJF، لوحة كانبان بحدود WIP، تخطيط سباقات بالسرعة الفعلية، سجل مخاطر مُقيَّم، توقعات إنجاز مونت كارلو، إدارة القيمة المكتسبة (EVM)، درجة صحة قابلة للتفسير، وتوصيات بالخطوة التالية. قوالب جاهزة للبرمجيات، وميزات الذكاء الاصطناعي، وMVP للشركات الناشئة، والحملات التسويقية، والقضايا القانونية، والإقرارات الضريبية، والإقفال المحاسبي، والتدقيق المالي. انظر: [إدارة المشاريع](documentation/Project-Management.md).

## ترقية النواة
المشاريع التي تضم AStack تُحدِّث نفسها بالأمر `astack upgrade` (أو `astack update`). أما التثبيتات الأقدم التي تسبق محرك الترقية فتنسخ الملف الواحد `scripts/astack-upgrade.mjs` إلى المشروع وتشغّله مرة واحدة — يجلب أحدث نواة ويطبّق منطق الترقية الجديد مع الحفاظ الكامل على `.astack/` و`memory/` والإضافات وحزم المعرفة وأي مسار مسجّل في `upgrade.keep`. انظر: [ترقية النواة](documentation/Upgrade.md) و[دليل الترحيل](documentation/Migration-Guide.md).

## الوثائق
المجموعة الكاملة في [`documentation/`](documentation/README.md) — المفاهيم، والتشغيل، وأدلة التوسعة، والأمان، والدليل الفارسي الكامل للمالك ([fa-guide.html](documentation/fa-guide.html)). جديد في 3.0: [المنفّذ والعملية الخلفية](documentation/Runner-and-Daemon.md)، [البوابة](documentation/Gateway.md)، [لوحة آرامين](documentation/Aramin-Console.md)، [البحث](documentation/Search.md)، [مركز المهارات](documentation/Skill-Hub.md)، [اللوحة والبيئة المعزولة والخزائن وA2A](documentation/Board-Sandbox-Vault.md).
