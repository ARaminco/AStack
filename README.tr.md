# AStack Enterprise

**Diller:** [English](README.md) · [فارسی](README.fa.md) · [العربية](README.ar.md) · Türkçe — **Belgeler:** [Belge Dizini](documentation/README.md)

AStack Enterprise, Claude Code ve OpenAI Codex içinde eşit düzeyde çalışan — tek ortak sözleşme, tek bellek, tek olay günlüğü — ve ChatGPT ile gelecekteki ajan çalışma ortamlarına da açık kalan modüler bir yapay zekâ işletim sistemidir. Her türlü işi yönetir — yazılım geliştirme, hukuki davalar, finans, vergi, muhasebe, pazarlama, operasyon, insan kaynakları, araştırma ve iş stratejisi — alan ekipleri kurarak, ajanlar oluşturarak ve bir liderlik katmanı altında zamanlanmış görevler devrederek. 3.0 ile birlikte **her zaman açık ve cebinizde**: gözetimsiz bir çalıştırıcı ve tek bir arka plan süreci, klavye başında kimse yokken de görevleri, zamanlanmış işleri ve kancaları yürütür; ona Telegram veya WhatsApp'tan komut verir, geri alınamaz adımlarını oradan onaylarsınız; uygulama olarak kurulabilen yerel konsol **Aramin** ise her onayı, görevi, çalıştırmayı ve denetim kaydını gösterir. Her yeni yetenek aynı güven modelinin içinde çalışır: yetki tavanları, onay makbuzları ve denetim izi.

## Özellikler

**Çalışma ortamları ve birlikte çalışma**
- Claude Code ve Codex tek sözleşme, tek bellek ve tek günlük üzerinde eşit düzeyde ([belge](documentation/Codex-and-Claude-Code.md))
- AStack token bütçeleri altında Graphify kod grafiği ([belge](documentation/Graphify.md))
- A2A uç noktası: diğer ajanlar AStack'ten plan isteyebilir; yalnızca yerel makinede, bearer token ile, varsayılan olarak yalnızca plan ([belge](documentation/Board-Sandbox-Vault.md#a2a-endpoint-interop-enginea2a-servermjs)) — *3.0'da yeni*

**Her zaman açık** — *3.0'da yeni*
- **Çalıştırıcı (runner)** — `astack run` bir hedefi veya görevi gözetimsiz yürütür: arayüzsüz Claude Code, `codex exec` veya yerel bir Ollama modeli ile; günlük ve çalıştırma başına bütçe, eşzamanlılık sınırı ve araçların kendisinde uygulanan yetki tavanı ile ([belge](documentation/Runner-and-Daemon.md))
- **Arka plan süreci (daemon)** — tek süreç çalıştırıcı kuyruğunu, zamanlayıcıyı, webhook dinleyicisini, ağ geçidini, arama yeniden dizinlemesini, panoyu ve konsolu yönetir, çöken hizmeti yeniden başlatır; Windows Görev Zamanlayıcı görevi, macOS LaunchAgent veya Linux systemd kullanıcı hizmeti olarak kurulur ([belge](documentation/Runner-and-Daemon.md#daemon-daemon-engine))
- **Pano (board)** — bağımlılıklar, yeniden denemeler, bağımsız gözden geçiren hattı ve canlı yönlendirme içeren kalıcı çok ajanlı kanban ([belge](documentation/Board-Sandbox-Vault.md#board-board-engine))

**Cebinizde** — *3.0'da yeni*
- **Ağ geçidi (gateway)** — AStack'e Telegram veya WhatsApp'tan komut verin (wapi uyumlu HTTP ağ geçidi, AStack'in kendi bağlı cihaz köprüsü veya Meta Cloud API ile); kanal başına birden çok hesapla sahip izin listeleri; «بفرست» / "approve" ile onay, «نه» / "deny" ile ret; Farsça sesli mesajların yerelde metne çevrilmesi ([belge](documentation/Gateway.md))
- **Aramin konsolu** — onaylar, görevler, bellek, çalıştırmalar, işler, denetim, beceriler, pano ve sistem durumu için yerel, kurulabilir web uygulaması (PWA); yalnızca yerel makinede, token ile giriş, varsayılan dil Farsça ([belge](documentation/Aramin-Console.md))

**Bellek ve hatırlama**
- **Çok yönlü ve zamansal bellek** — on iki bellek yüzü, üzerine yazmak yerine geçersiz kılma, gecelik konsolidasyon ([belge](documentation/Memory-OS.md))
- **Arama** — bellek, geçmiş Claude Code ve Codex oturumları, raporlar, beceriler ve görevler üzerinde Farsçayı anlayan tek bir dizin: SQLite FTS5 ve isteğe bağlı Ollama gömmeleri, ayrıca deterministik bir sahip profili ([belge](documentation/Search.md)) — *3.0'da yeni*
- **Bağlam motoru** — çalışma alanı haritası, sembol dizini ve alan kayıtları grafiği, belirli bir token bütçesi içinde ([belge](documentation/Context-Engine.md))
- **Bilgi grafiği** — kişiler, şirketler, davalar, hesaplar ve zaman içindeki ilişkileri ([belge](documentation/Knowledge-Graph.md))

**Beceriler ve öğrenme**
- **Öğrenme motoru** — tekrar eden iş, kanıta dayalı ve sürümlenmiş bir beceriye dönüşür ([belge](documentation/Learning-Engine.md))
- **Beceri merkezi (skill hub)** — `SKILL.md` becerileri yardımcı paketlere aktarılır, statik bir güvenlik tarayıcısından geçer ve her zaman yerleşik becerilerin altında sıralanır; Hermes Agent paketi (211 MIT lisanslı beceri) dahildir; yüksek riskli beceriler asla otomatik seçilmez ve ikisi tamamen engellidir; bir küratör tut, iyileştir veya emekliye ayır önerir ([belge](documentation/Skill-Hub.md)) — *3.0'da yeni*

**Güvenli gerçek iş**
- **Görevler** — kalıcı, devam ettirilebilir; onay kontrol noktaları, deneme çalıştırması ve yeniden oynatma ile ([belge](documentation/Autonomous-Organization.md))
- **Dahili tarayıcı** — kalıcı oturumlar, formlarla gerçek çalışma, zincirlenmiş kanıtlar, gönderimden önce duraklama ([belge](documentation/Browser-Operator.md))
- **Zamanlayıcı ve kancalar** — arka plan izleme ve görev oluşturan ya da çalıştırıcı kuyruğuna iş ekleyen gelen olaylar ([belge](documentation/Scheduler-and-Signals.md))
- **Korumalı alan (sandbox)** — Docker içinde yalıtılmış komut çalıştırma: ağ yok, salt okunur kök, gizli bilgiler saklı ([belge](documentation/Board-Sandbox-Vault.md#sandbox-sandbox-engine)) — *3.0'da yeni*

**Güven**
- L0–L5 yetki seviyeleri, onay makbuzları, denetim izi, kimlik bilgisi aracısı ([belge](documentation/Security-and-Authority.md))
- Gizli bilgiler için işletim sistemi kasaları (Windows DPAPI; macOS Keychain, Linux Secret Service, Bitwarden ve 1Password adaptörleri) ve çözülen her gizli değeri tüm çıktılardan silen bir koruma ([belge](documentation/Board-Sandbox-Vault.md#vault-backends-trust-enginevaultmjs)) — *3.0'da yeni*

**Organizasyon ve teslim**
- On iş alanı, 33 departman, 219 rol, ekipler, ajanlar ve liderlik katmanı ([belge](documentation/Orchestration.md))
- PERT, WSJF, WIP sınırları, Monte Carlo tahminleri ve EVM ile aşama kapılı proje teslimi ([belge](documentation/Project-Management.md))
- Yedekli, sahip özelleştirmelerini üç yönlü birleştiren ve hata halinde otomatik geri alan güvenli çekirdek yükseltmeleri ([belge](documentation/Upgrade.md))

## Çalışma Ortamı
- Çalışma ortamları: Claude Code ve Codex eşit düzeyde ([tek beyni nasıl paylaşırlar](documentation/Codex-and-Claude-Code.md), [Claude Code döngüsü](documentation/Claude-Code.md)); gözetimsiz çalıştırmalar [çalıştırıcı](documentation/Runner-and-Daemon.md) ile
- Kod grafiği: her iki ortam için AStack token bütçeleri altında [Graphify](documentation/Graphify.md) (`node bin/astack.mjs graphify setup`)
- Ortak sözleşme: `AGENTS.md` (Codex doğrudan okur, `CLAUDE.md` içe aktarır); iki ortamı bağlamak için `node bin/astack.mjs interop sync`
- Sahiple iletişim: Farsça — kod ve teknik belgeler: İngilizce
- Mimari: katmanlı, eklentiye açık, sağlayıcıdan bağımsız, alan-farkındalıklı ([ayrıntılar](documentation/Architecture.md))

## Her projeye kurulum
Yeni veya eski, AStack çekirdeği olsun ya da olmasın — tek komut çekirdeği, Claude Code + Codex'i, Graphify'ı, dizini ve genel `astack-setup` becerisini kurar (sonrasında herhangi bir ortama "install / set up" demek yeterlidir):
```bash
git clone --depth 1 https://github.com/ARaminco/AStack.git ~/.astack/core   # veya: git -C ~/.astack/core pull
node ~/.astack/core/bin/astack.mjs setup --target /path/to/project
```
Herhangi bir projeyi güncellemek için Claude Code'a veya Codex'e "update AStack" (ya da «آپدیت کن») deyin veya [güncelleme hattını](documentation/Upgrade.md) doğrudan çalıştırın: `node ~/.astack/core/bin/astack.mjs update --target /path/to/project`.

## Hızlı Başlangıç
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
Devamı: [Kurulum](documentation/Installation.md) ve [Komut Referansı](documentation/API.md).

### Her zaman açık asistanı başlatın (3.0)
3.0'ın tüm motorları siz açana kadar kapalı veya salt okunurdur. Dört adım:

```bash
# 1. Çalıştırıcı: Claude Code'un gözetimsiz başlatılmasına bir kez izin verin, sonra bir çalıştırmayı önizleyin
node bin/astack.mjs schedule policy allow-command claude
node bin/astack.mjs runner engines
node bin/astack.mjs run "summarize today's open missions" --dry-run

# 2. Arka plan süreci: çalıştırıcı, zamanlayıcı, kancalar, ağ geçidi, arama, pano ve konsol için tek süreç
node bin/astack.mjs daemon start
node bin/astack.mjs daemon status
node bin/astack.mjs daemon install-service --dry-run   # planı inceleyin, oturum açılışında başlaması için --dry-run olmadan çalıştırın

# 3. Aramin konsolu: arka plan süreci çalışırken tarayıcıyı oturum açılmış olarak açar
node bin/astack.mjs console open                        # arka plan süreci yoksa: astack console start --open

# 4. Telegram ağ geçidi: önce @BotFather ile bir bot oluşturun
node bin/astack.mjs secret vault set credential://telegram/bot           # bot token'ını gizli isteme yapıştırın
node bin/astack.mjs gateway owner add telegram <sayısal Telegram kullanıcı kimliğiniz>
```

Ardından ağ geçidini `astack.config.yaml` içinde açın ve arka plan sürecini yeniden başlatın:

```yaml
gateway:
  enabled: true
  channels:
    telegram:
      enabled: true
```

```bash
node bin/astack.mjs gateway test telegram     # salt okunur sağlık kontrolü
node bin/astack.mjs daemon stop && node bin/astack.mjs daemon start
```

Bota bir mesaj gönderin: çalıştırıcı için bir isteğe dönüşür. Onay istekleri tam değerlerle ve dört karakterlik bir kodla gelir; isteğe «بفرست» veya "approve" ile yanıt verin (ya da «نه» / "deny"). WhatsApp kanalları, sesli mesajlar ve tüm kurallar [Ağ Geçidi kılavuzunda](documentation/Gateway.md).

## 3.0'a yükseltme
3.0 tamamen eklemelidir: 2.5.1'in her komutu, dosya biçimi ve testi değişmeden çalışır ve her yeni motor yapılandırılana kadar kapalı veya salt okunurdur. Her zamanki gibi güncelleyin:

```bash
node bin/astack.mjs update            # veya Claude Code / Codex'e «آپدیت کن» deyin
```

Güncelleme yeni motorları ve `skill-packs/` klasörünü getirir, `astack.config.yaml` dosyasına dokunmaz (3.0 bölümleri yorum satırı halinde varsayılanlar olarak gelir) ve `.astack/` altındaki 3.0 durum klasörlerini mevcut `.gitignore` dosyasına ekleyen `2026.8-ignore-v3-state` geçişini çalıştırır. Sonra [Her zaman açık asistanı başlatın](#her-zaman-açık-asistanı-başlatın-30) adımlarını izleyin. Ayrıntılar: [Çekirdek Yükseltmeleri](documentation/Upgrade.md) ve [CHANGELOG](CHANGELOG.md).

## Özerk Organizasyon
AStack sahibini konuşmalar arasında hatırlar, her istek için gereken en küçük uzman ekibi kurar, gerçek araçlarla yazılımları ve web sitelerini işletir, geri alınamaz her adımdan önce durur, sonucu doğrular, denetim kaydına yazar ve deneyimden öğrenir.

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

Tamamını [Autonomous Organization](documentation/Autonomous-Organization.md) belgesinde okuyun; oradaki özellik durumu tablosu neyin gerçekten uygulandığını, neyin yalnızca adaptöre hazır olduğunu ayırır. Yapı taşları [Özellikler](#özellikler) bölümündedir.

## İş Alanları
Alan kayıt defteri her isteği — Farsça veya İngilizce — doğru departmanlara, iş akışına ve ekip şablonuna yönlendirir: yazılım, hukuk, finans, muhasebe, vergi, pazarlama, operasyon, insan kaynakları, araştırma ve iş. Bakınız: [Departmanlar](documentation/Departments.md) ve [Roller](documentation/Roles.md) (33 departman, 219 uzman rol).

## Ekipler, Ajanlar ve Liderlik
- `astack team` — alan şablonlarından çok disiplinli ekipler kurma ve yönetme
- `astack agent` — ajan oluşturma, tek seferlik veya tekrarlayan görev zamanlama, iş emri gönderme ve rapor kaydetme
- `astack lead` — liderlik katmanı: planlama, ekip kurma, proje işlerini devretme, durum toplantısı ve çıktı incelemesi
- `astack board` — ajanlar ve ekipler için kartları gözetimsiz çalıştırma, yeniden deneme ve gözden geçiren hattı ile (3.0)

Tam kılavuz: [Alanlar, Ekipler, Ajanlar ve Liderlik](documentation/Orchestration.md).

## Proje Teslimi
Teslim motoru projeleri profesyonel bir teslim ekibi gibi yönetir: aşama kapılı yaşam döngüsü, PERT tahminleri, WSJF sıralı iş listesi, WIP sınırlı kanban, gerçek hıza dayalı sprint planlama, puanlanmış risk kaydı, Monte Carlo tamamlanma tahminleri, kazanılmış değer yönetimi (EVM), açıklanabilir sağlık puanı ve sonraki-en-iyi-eylem önerileri. Hazır şablonlar: yazılım, yapay zekâ özelliği, startup MVP, pazarlama kampanyası, hukuki dava, vergi beyannamesi, muhasebe kapanışı ve mali denetim. Bakınız: [Proje Yönetimi](documentation/Project-Management.md).

## Çekirdek Yükseltmeleri
AStack gömülü projeler kendilerini `astack upgrade` (veya `astack update`) ile günceller. Yükseltme motorundan önceki eski kurulumlar ise tek dosyalık `scripts/astack-upgrade.mjs` betiğini projeye kopyalayıp bir kez çalıştırır — en son çekirdeği indirir ve yeni yükseltme mantığını uygular; `.astack/`, `memory/`, eklentiler, bilgi paketleri ve `upgrade.keep` altındaki her yol korunur. Bakınız: [Çekirdek Yükseltmeleri](documentation/Upgrade.md) ve [Geçiş Kılavuzu](documentation/Migration-Guide.md).

## Belgeler
Belgelerin tamamı [`documentation/`](documentation/README.md) altındadır — kavramlar, operasyon, genişletme kılavuzları, güvenlik ve sahibe özel tam Farsça kılavuz ([fa-guide.html](documentation/fa-guide.html)). 3.0'da yeni: [Çalıştırıcı ve Arka Plan Süreci](documentation/Runner-and-Daemon.md), [Ağ Geçidi](documentation/Gateway.md), [Aramin Konsolu](documentation/Aramin-Console.md), [Arama](documentation/Search.md), [Beceri Merkezi](documentation/Skill-Hub.md), [Pano, Korumalı Alan, Kasa ve A2A](documentation/Board-Sandbox-Vault.md).
