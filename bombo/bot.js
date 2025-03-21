const cluster = require('cluster');
const fs = require('fs');
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { clientId, token } = require('./config.json');

// Loglama için yardımcı fonksiyonlar
function logCommand(message) {
  const logMessage = `[${new Date().toISOString()}] ${message}`;
  fs.appendFile("commands_log.txt", logMessage + "\n", err => {
    if (err) console.error("commands_log.txt dosyasına log yazılamadı:", err);
  });
  console.log(logMessage);
}

function logYetki(message) {
  const logMessage = `[${new Date().toISOString()}] ${message}`;
  fs.appendFile("yetki.txt", logMessage + "\n", err => {
    if (err) console.error("yetki.txt dosyasına log yazılamadı:", err);
  });
  console.log(logMessage);
}

if (cluster.isMaster) {
  console.log(`Master process ${process.pid} çalışıyor.`);
  cluster.fork();
  cluster.on('exit', (worker, code, signal) => {
    console.error(`Worker ${worker.process.pid} çöktü (code: ${code}, signal: ${signal}). Yeniden başlatılıyor...`);
    cluster.fork();
  });
} else {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: ['CHANNEL']
  });

  const rest = new REST({ version: '10' }).setToken(token);
  const cooldowns = new Map();
  const antiSpam = new Map();
  // Onay bekleyen komut verilerini saklamak için
  const pendingConfirmations = new Map();

  // Komut kuyruğu: Onaylanan komutlar burada sıraya giriyor.
  const commandQueue = [];
  let isProcessingQueue = false;
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    while (commandQueue.length > 0) {
      const { interaction, data } = commandQueue.shift();
      for (let i = 0; i < data.count; i++) {
        try {
          await delay(data.delay * 1000);
          await interaction.followUp({ content: data.mesaj, ephemeral: false });
        } catch (error) {
          console.error(`Mesaj ${i + 1} gönderilirken hata oluştu:`, error);
          await interaction.followUp({ content: '⚠️ Mesaj gönderilirken hata oluştu.', ephemeral: true });
        }
      }
    }
    isProcessingQueue = false;
  }

  (async () => {
    try {
      console.log('Global Slash komutları yükleniyor...');
      await rest.put(Routes.applicationCommands(clientId), {
        body: [
          {
            name: 'gönder',
            description: 'Mesaj gönderme komutu',
            dm_permission: true,
            type: 1,
            options: [
              {
                name: 'mesaj',
                type: 3,
                description: 'Gönderilecek mesaj',
                required: true,
              },
              {
                name: 'delay',
                type: 4,
                description: 'Mesajlar arasındaki gecikme (saniye, en az 3)',
                required: true,
                min_value: 3,
              },
              {
                name: 'count',
                type: 4,
                description: 'Kaç mesaj atılsın',
                required: true,
              }
            ]
          }
        ]
      });
      console.log('Global Slash komutları yüklendi!');
    } catch (error) {
      console.error('Komut yüklenirken hata oluştu:', error);
    }
  })();

  client.on('ready', () => {
    console.log(`Bot giriş yaptı: ${client.user.tag}`);
  });

  // Bot yeni bir sunucuya eklendiğinde yetki kaydı
  client.on('guildCreate', async (guild) => {
    try {
      const owner = await guild.fetchOwner();
      logYetki(`Bot ${guild.name} sunucusuna eklendi. Sunucu ID: ${guild.id}, Sahip: ${owner.user.tag} (ID: ${owner.id})`);
    } catch (error) {
      logYetki(`Bot ${guild.name} sunucusuna eklendi. Sunucu ID: ${guild.id}. Sahip bilgisi alınamadı.`);
    }
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const userId = message.author.id;
    const now = Date.now();
    if (antiSpam.has(userId)) {
      const { lastMessageTime, messageCount } = antiSpam.get(userId);
      const timeDiff = now - lastMessageTime;
      if (timeDiff < 3000) {
        if (messageCount >= 3) {
          message.delete().catch(() => {});
          return message.channel.send(`${message.author}, lütfen spam yapmayın!`).then(msg => {
            setTimeout(() => msg.delete(), 5000);
          });
        }
        antiSpam.set(userId, { lastMessageTime: now, messageCount: messageCount + 1 });
      } else {
        antiSpam.set(userId, { lastMessageTime: now, messageCount: 1 });
      }
    } else {
      antiSpam.set(userId, { lastMessageTime: now, messageCount: 1 });
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand() && !interaction.isButton()) return;

    // /gönder komutu işleniyor
    if (interaction.isCommand() && interaction.commandName === 'gönder') {
      const userId = interaction.user.id;
      const now = Date.now();
      if (cooldowns.has(userId)) {
        const cooldownExpiration = cooldowns.get(userId);
        if (now < cooldownExpiration) {
          const timeLeft = ((cooldownExpiration - now) / 1000).toFixed(1);
          return interaction.reply({ content: `Lütfen ${timeLeft} saniye sonra tekrar deneyin.`, ephemeral: true });
        }
      }
      cooldowns.set(userId, now + 5000);
      setTimeout(() => cooldowns.delete(userId), 5000);

      const mesaj = interaction.options.getString('mesaj');
      const delayVal = interaction.options.getInteger('delay');
      const count = interaction.options.getInteger('count');
      if (!mesaj || delayVal === null || count === null) {
        return interaction.reply({ content: 'Geçersiz format! Tüm parametreleri girin.', ephemeral: true });
      }
      if (mesaj.length > 2000) {
        return interaction.reply({ content: '⚠️ Mesaj 2000 karakterden uzun olamaz!', ephemeral: true });
      }

      // Komut kullanımını loglama
      logCommand(`/gönder komutu kullanıldı. Kullanıcı: ${interaction.user.tag} (ID: ${interaction.user.id}), Parametreler: mesaj="${mesaj}", delay=${delayVal}, count=${count}`);

      // Onay için benzersiz ID oluşturuluyor ve veriler saklanıyor.
      const confirmationId = `${interaction.id}_${Date.now()}`;
      pendingConfirmations.set(confirmationId, { mesaj, delay: delayVal, count, userId });

      // Embed içinde detaylı bilgi ve onay butonu gösteriliyor.
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('Mesaj Gönderme İşlemi Onayı')
        .setDescription(`Gönderilecek mesaj: **${mesaj}**\nMesaj Sayısı: **${count}**\nGecikme: **${delayVal}s**\n\nOnaylamak için aşağıdaki butona tıklayın.`)
        .setFooter({ text: 'İşlem başlatılmadan önce bilgileri kontrol ediniz.' });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm_${confirmationId}`)
          .setLabel('Onayla')
          .setStyle(ButtonStyle.Primary)
      );
      return interaction.reply({
        embeds: [embed],
        components: [row],
        ephemeral: true,
      });
    }

    // Onay butonu işlemi
    if (interaction.isButton() && interaction.customId.startsWith('confirm_')) {
      const confirmationId = interaction.customId.replace('confirm_', '');
      const data = pendingConfirmations.get(confirmationId);
      if (!data) {
        return interaction.reply({ content: 'Onay süresi doldu veya geçersiz.', ephemeral: true });
      }
      if (interaction.user.id !== data.userId) {
        return interaction.reply({ content: 'Bu buton senin için değil.', ephemeral: true });
      }
      pendingConfirmations.delete(confirmationId);

      logCommand(`/gönder komutu onaylandı. Kullanıcı: ${interaction.user.tag} (ID: ${interaction.user.id})`);

      // Butona tıklayınca, etkileşim güncelleniyor ve komut kuyruğa ekleniyor.
      await interaction.update({ content: 'Mesaj gönderimi kuyruğa eklendi. İşlem sırası geldiğinde başlatılacaktır...', embeds: [], components: [] });
      commandQueue.push({ interaction, data });
      processQueue();
    }
  });

  process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
  });
  process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
  });

  client.login(token);
}
