# AStack Enterprise

**Diller:** [English](README.md) · [فارسی](README.fa.md) · [العربية](README.ar.md) · Türkçe — **Belgeler:** [Belge Dizini](documentation/README.md)

AStack Enterprise, öncelikle Claude Code içinde çalışmak üzere tasarlanmış; OpenAI Codex, ChatGPT ve gelecekteki ajan çalışma ortamlarıyla da uyumlu, modüler bir yapay zekâ işletim sistemidir. Her türlü işi yönetir — yazılım geliştirme, hukuki davalar, finans, vergi, muhasebe, pazarlama, operasyon, insan kaynakları, araştırma ve iş stratejisi — alan ekipleri kurarak, ajanlar oluşturarak ve bir liderlik katmanı altında zamanlanmış görevler devrederek.

## Çalışma Ortamı
- Birincil çalışma ortamı: Claude Code ([AStack'i nasıl çalıştırır](documentation/Claude-Code.md))
- Sahiple iletişim: Farsça — kod ve teknik belgeler: İngilizce
- Mimari: katmanlı, eklentiye açık, sağlayıcıdan bağımsız, alan-farkındalıklı ([ayrıntılar](documentation/Architecture.md))

## Hızlı Başlangıç
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
Devamı: [Kurulum](documentation/Installation.md) ve [Komut Referansı](documentation/API.md).

## İş Alanları
Alan kayıt defteri her isteği — Farsça veya İngilizce — doğru departmanlara, iş akışına ve ekip şablonuna yönlendirir: yazılım, hukuk, finans, muhasebe, vergi, pazarlama, operasyon, insan kaynakları, araştırma ve iş. Bakınız: [Departmanlar](documentation/Departments.md) ve [Roller](documentation/Roles.md) (33 departman, 219 uzman rol).

## Ekipler, Ajanlar ve Liderlik
- `astack team` — alan şablonlarından çok disiplinli ekipler kurma ve yönetme
- `astack agent` — ajan oluşturma, tek seferlik veya tekrarlayan görev zamanlama, iş emri gönderme ve rapor kaydetme
- `astack lead` — liderlik katmanı: planlama, ekip kurma, proje işlerini devretme, durum toplantısı ve çıktı incelemesi

Tam kılavuz: [Alanlar, Ekipler, Ajanlar ve Liderlik](documentation/Orchestration.md).

## Proje Teslimi
Teslim motoru projeleri profesyonel bir teslim ekibi gibi yönetir: aşama kapılı yaşam döngüsü, PERT tahminleri, WSJF sıralı iş listesi, WIP sınırlı kanban, gerçek hıza dayalı sprint planlama, puanlanmış risk kaydı, Monte Carlo tamamlanma tahminleri, kazanılmış değer yönetimi (EVM), açıklanabilir sağlık puanı ve sonraki-en-iyi-eylem önerileri. Hazır şablonlar: yazılım, yapay zekâ özelliği, startup MVP, pazarlama kampanyası, hukuki dava, vergi beyannamesi, muhasebe kapanışı ve mali denetim. Bakınız: [Proje Yönetimi](documentation/Project-Management.md).

## Çekirdek Yükseltmeleri
AStack gömülü projeler kendilerini `astack upgrade` ile günceller. Yükseltme motorundan önceki eski kurulumlar ise tek dosyalık `scripts/astack-upgrade.mjs` betiğini projeye kopyalayıp bir kez çalıştırır — en son çekirdeği indirir ve yeni yükseltme mantığını uygular; `.astack/`, `memory/`, eklentiler, bilgi paketleri ve `upgrade.keep` altındaki her yol korunur. Bakınız: [Çekirdek Yükseltmeleri](documentation/Upgrade.md) ve [Geçiş Kılavuzu](documentation/Migration-Guide.md).

## Belgeler
Belgelerin tamamı [`documentation/`](documentation/README.md) altındadır — kavramlar, operasyon, genişletme kılavuzları, güvenlik ve sahibe özel tam Farsça kılavuz ([fa-guide.html](documentation/fa-guide.html)).
