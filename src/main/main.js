// Processus principal de Lost Island Fichiers : fenêtre, compte, accès au disque, file des transferts.
// L'interface (src/renderer) ne touche ni au disque ni au réseau : elle passe par src/preload.js.
const { app, BrowserWindow, Menu, dialog, ipcMain, screen, shell } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const config = require("./config");
const contrat = require("./contrat");
const { Client, traduire } = require("./api");
const { Reprises } = require("./reprises");
const { FileTransferts } = require("./transferts");
const operations = require("./operations");
const local = require("./local");
const maj = require("./maj");

// Mode d'essai (jamais dans l'application installée) : LI_ESSAI=1 démarre un serveur factice local et ouvre
// l'écran principal sans compte ; LI_ESSAI=connexion montre l'écran de connexion. Réglages à part.
const ESSAI = !app.isPackaged && process.env.LI_ESSAI ? process.env.LI_ESSAI : null;
if (ESSAI) app.setPath("userData", path.join(os.tmpdir(), "lostisland-fichiers-essai", "donnees"));
// Autre adresse de l'API, pour le développement seulement.
const API = (!app.isPackaged && process.env.LI_API) || config.API;

const stockage = require("./stockage");

let fenetre = null;
let session = null; // { client, file, nom }
let essai = null; // { base, fermer } du serveur factice

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (!fenetre) return;
  if (fenetre.isMinimized()) fenetre.restore();
  fenetre.focus();
});

// Essais et captures (jamais dans l'application installée) : la fenêtre s'ouvre sur un autre écran que
// l'écran principal, s'il y en a un, pour ne pas gêner le travail en cours.
function placeEssai() {
  if (app.isPackaged || !(ESSAI || process.env.LI_CAPTURE)) return {};
  const principal = screen.getPrimaryDisplay();
  const autre = screen.getAllDisplays().find((d) => d.id !== principal.id);
  if (!autre) return {};
  const z = autre.workArea;
  return { x: z.x + Math.max(0, Math.floor((z.width - 1320) / 2)), y: z.y + Math.max(0, Math.floor((z.height - 820) / 2)) };
}

function creerFenetre() {
  fenetre = new BrowserWindow({
    ...placeEssai(),
    width: 1320,
    height: 820,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: "#082019",
    title: "Lost Island Fichiers",
    icon: path.join(__dirname, "..", "renderer", "assets", "icone.png"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  fenetre.once("ready-to-show", () => fenetre.show());
  fenetre.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  fenetre.webContents.setWindowOpenHandler(({ url }) => {
    ouvrirLien(url);
    return { action: "deny" };
  });
  // Un fichier lâché à côté d'un volet ne doit jamais remplacer la page.
  fenetre.webContents.on("will-navigate", (e) => e.preventDefault());
  fenetre.on("close", (e) => {
    if (!session?.file.enCours() || process.env.LI_CAPTURE) return;
    const choix = dialog.showMessageBoxSync(fenetre, {
      type: "warning",
      buttons: ["Quitter", "Rester"],
      defaultId: 1,
      cancelId: 1,
      title: "Transferts en cours",
      message: "Des transferts sont en cours.",
      detail: "Quitter les arrête. Les gros envois reprendront là où ils en étaient la prochaine fois que vous les relancerez.",
    });
    if (choix === 1) e.preventDefault();
    else session.file.annulerTout();
  });
  fenetre.on("closed", () => (fenetre = null));
  // Développement : les messages de la console de l'interface s'affichent dans le terminal.
  if (!app.isPackaged) {
    fenetre.webContents.on("console-message", (e) => console.log(`[interface] ${e.message}`));
  }
}

const LIENS_SURS = [/^https:\/\/lostisland\.eriniumlab\.com(\/|$)/, /^https:\/\/github\.com\/JLSkyzer\//];
function ouvrirLien(url) {
  if (LIENS_SURS.some((r) => r.test(url))) shell.openExternal(url);
}

const envoyer = (canal, donnee) => fenetre?.webContents.send(canal, donnee);

// Chaque échange renvoie { ok: true, ... } ou { ok: false, erreur } : jamais d'exception vers l'interface.
function gerer(canal, f) {
  ipcMain.handle(canal, async (_e, ...args) => {
    try {
      return { ok: true, ...(await f(...args)) };
    } catch (e) {
      const t = traduire(e);
      if (t.statut === 401 && session) envoyer("session-perdue", { erreur: t.message });
      return { ok: false, erreur: t.name === "AbortError" ? "Annulé." : t.message, statut: t.statut ?? null };
    }
  });
}

function exigerSession() {
  if (!session) throw new Error("Vous n'êtes plus connecté.");
  return session;
}
const texte = (v, nom = "valeur") => {
  if (typeof v !== "string") throw new Error(`Paramètre invalide : ${nom}.`);
  return v;
};
const absolu = (v) => {
  const p = texte(v, "chemin");
  if (!path.isAbsolute(p)) throw new Error("Chemin local invalide.");
  return path.resolve(p);
};

/* Session */

function nouveauClient(nom, motDePasse) {
  return new Client({
    base: essai?.base ?? API,
    nom,
    motDePasse,
    agentUtilisateur: `LostIslandFichiers/${app.getVersion()} (${process.platform})`,
    reprises: new Reprises(path.join(app.getPath("userData"), "envois-en-cours.json")),
  });
}

function ouvrirSession(client, nom) {
  fermerSession();
  const file = new FileTransferts(client);
  file.on("maj", (liste) => envoyer("transferts", liste));
  file.on("fini", (e) => envoyer("transfert-fini", e));
  session = { client, file, nom };
}

function fermerSession() {
  if (!session) return;
  session.file.annulerTout();
  session.file.removeAllListeners();
  session.client.fermer();
  session = null;
}

// Vérifie les identifiants par GET /liste?chemin= (le contrat ne prévoit pas d'autre route pour cela).
async function essayer(nom, motDePasse) {
  const client = nouveauClient(nom, motDePasse);
  try {
    await client.liste("");
    return client;
  } catch (e) {
    client.fermer();
    throw e;
  }
}

gerer("demarrage", async () => {
  const r = stockage.lire();
  const base = {
    version: app.getVersion(),
    plateforme: process.platform,
    nom: r.nom,
    souvenir: r.souvenir,
    chiffrement: stockage.chiffrementDisponible(),
    essai: ESSAI ? { scenario: process.env.LI_ESSAI_SCENARIO ?? null } : null,
    session: null,
  };
  if (ESSAI && ESSAI !== "connexion") {
    ouvrirSession(nouveauClient("essai", "essai"), "essai");
    return { ...base, session: { nom: "essai" } };
  }
  const retenu = stockage.compteRetenu();
  if (!retenu) return base;
  try {
    ouvrirSession(await essayer(retenu.nom, retenu.motDePasse), retenu.nom);
    return { ...base, session: { nom: retenu.nom } };
  } catch (e) {
    if (e.statut === 401) stockage.oublierMotDePasse();
    return { ...base, souvenir: stockage.lire().souvenir, erreurAuto: traduire(e).message };
  }
});

gerer("connexion", async (d) => {
  const nom = texte(d?.nom, "nom").trim();
  const motDePasse = texte(d?.motDePasse, "mot de passe");
  if (!nom || !motDePasse) throw new Error("Saisissez le nom et le mot de passe du compte d'accès.");
  const client = await essayer(nom, motDePasse);
  ouvrirSession(client, nom);
  const retenu = stockage.retenir(nom, motDePasse, !!d?.souvenir);
  return {
    nom,
    avertissement: retenu ? null : "Ce système ne permet pas de chiffrer le mot de passe : il ne sera pas retenu.",
  };
});

gerer("deconnexion", async () => {
  fermerSession();
  stockage.oublierMotDePasse();
  return {};
});

/* Côté PC */

gerer("local-depart", async () => {
  const d = ESSAI ? dossierEssaiLocal() : stockage.lire().dossierLocal;
  try {
    if (d && fs.statSync(d).isDirectory()) return { dossier: d };
  } catch {}
  return { dossier: ESSAI ? dossierEssaiLocal() : os.homedir() };
});

gerer("local-lister", async (dossier) => {
  const d = absolu(dossier);
  const entrees = await local.lister(d);
  stockage.ecrire({ dossierLocal: d });
  const p = path.dirname(d);
  return { dossier: d, parent: p !== d ? p : null, entrees, separateur: path.sep };
});

gerer("local-choisir", async (depart) => {
  const r = await dialog.showOpenDialog(fenetre, { title: "Choisir un dossier", properties: ["openDirectory", "createDirectory"], defaultPath: typeof depart === "string" ? depart : os.homedir() });
  return { dossier: r.canceled ? null : r.filePaths[0] };
});

gerer("local-nouveau-dossier", async (dossier, nom) => {
  const refus = contrat.refusNom(texte(nom, "nom"));
  if (refus && !nom.startsWith(".")) throw new Error(refus);
  const p = path.join(absolu(dossier), nom);
  await fs.promises.mkdir(p);
  return { chemin: p };
});

gerer("local-ouvrir", async (chemin) => {
  const p = absolu(chemin);
  const st = await fs.promises.stat(p);
  if (st.isDirectory()) {
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  } else shell.showItemInFolder(p);
  return {};
});

// Fichiers lâchés depuis l'explorateur du système : leur nature, pour l'interface.
gerer("local-infos", async (chemins) => {
  if (!Array.isArray(chemins)) throw new Error("Paramètre invalide.");
  const r = [];
  for (const c of chemins) {
    try {
      const p = absolu(c);
      const st = await fs.promises.stat(p);
      r.push({ chemin: p, nom: path.basename(p), dossier: st.isDirectory() });
    } catch {}
  }
  return { elements: r };
});

/* Côté serveur */

gerer("distant-lister", async (chemin) => {
  const r = await exigerSession().client.liste(texte(chemin, "chemin"));
  return { chemin: r.chemin, entrees: r.entrees };
});

gerer("distant-nouveau-dossier", async (dossier, nom) => {
  const refus = contrat.refusNom(texte(nom, "nom"));
  if (refus) throw new Error(refus);
  await exigerSession().client.creerDossier(contrat.joindre(texte(dossier, "dossier"), nom));
  return {};
});

gerer("distant-renommer", async (de, nom) => {
  const refus = contrat.refusNom(texte(nom, "nom"));
  if (refus) throw new Error(refus);
  const src = contrat.normaliser(texte(de, "chemin"));
  await exigerSession().client.renommer(src, contrat.joindre(contrat.parent(src), nom));
  return {};
});

gerer("distant-supprimer", async (chemins) => {
  if (!Array.isArray(chemins) || !chemins.length) throw new Error("Rien à supprimer.");
  const { client } = exigerSession();
  const erreurs = [];
  for (const c of chemins) {
    try {
      await client.supprimer(texte(c, "chemin"));
    } catch (e) {
      if (e.statut === 401 || contrat.aRetenter(e)) throw e;
      erreurs.push(`${c} : ${traduire(e).message}`);
    }
  }
  if (erreurs.length) throw new Error(erreurs.join("\n"));
  return {};
});

/* Transferts */

gerer("envoyer", async (chemins, dossierDistant) => {
  if (!Array.isArray(chemins) || !chemins.length) throw new Error("Rien à envoyer.");
  const abs = chemins.map(absolu);
  const dest = contrat.normaliser(texte(dossierDistant, "dossier"));
  const { file } = exigerSession();
  // Un élément de la file par fichier ou dossier choisi.
  for (const c of abs) {
    file.ajouter({ sens: "envoi", titre: path.basename(c), detail: dest ? `vers /${dest}` : "vers la racine", cible: { cote: "distant", chemin: dest }, preparer: operations.preparerEnvoi([c], dest) });
  }
  return {};
});

gerer("telecharger", async (elements, dossierLocal) => {
  if (!Array.isArray(elements) || !elements.length) throw new Error("Rien à télécharger.");
  const dest = absolu(dossierLocal);
  const { file, client } = exigerSession();
  for (const el of elements) {
    const chemin = contrat.normaliser(texte(el?.chemin, "chemin"));
    const propre = { chemin, dossier: !!el.dossier, taille: Number(el.taille) || 0 };
    file.ajouter({ sens: "telechargement", titre: contrat.nomDe(chemin), detail: `vers ${dest}`, cible: { cote: "local", chemin: dest }, preparer: operations.preparerTelechargement(client, [propre], dest) });
  }
  return {};
});

gerer("transfert-annuler", async (id) => ({ annule: exigerSession().file.annuler(Number(id)) }));
gerer("transferts-effacer", async () => {
  exigerSession().file.effacerTermines();
  return {};
});

/* Synchronisation : l'aperçu est gardé ici, l'interface n'en reçoit qu'une copie sans chemins absolus. */

let apercu = null;
let controleApercu = null;

gerer("sync-apercu", async (d) => {
  const { client } = exigerSession();
  const dossierLocal = absolu(d?.dossierLocal);
  const dossierDistant = contrat.normaliser(texte(d?.dossierDistant ?? "", "dossier"));
  controleApercu?.abort();
  controleApercu = new AbortController();
  const signal = controleApercu.signal;
  apercu = null;
  const a = await operations.apercuSynchronisation(client, dossierLocal, dossierDistant, {
    supprimer: d?.supprimer !== false,
    signal,
    surEtape: (e) => envoyer("sync-etape", e),
  });
  apercu = { ...a, id: Date.now() };
  const pub = (f) => ({ chemin: f.chemin, taille: f.taille });
  return { id: apercu.id, envoyer: a.envoyer.map(pub), remplacer: a.remplacer.map(pub), supprimer: a.supprimer.map(pub), suppressions: a.suppressions, identiques: a.identiques, octets: a.octets, dossierLocal, dossierDistant, supprimerActive: a.supprimerActive };
});

gerer("sync-annuler-apercu", async () => {
  controleApercu?.abort();
  return {};
});

gerer("sync-appliquer", async (id) => {
  if (!apercu || apercu.id !== id) throw new Error("Aperçu périmé : relancez la synchronisation.");
  const a = apercu;
  apercu = null;
  exigerSession().file.ajouter({
    sens: "sync",
    titre: `Synchronisation de ${path.basename(a.dossierLocal)}`,
    detail: a.dossierDistant ? `vers /${a.dossierDistant}` : "vers la racine",
    cible: { cote: "distant", chemin: a.dossierDistant },
    preparer: operations.preparerSynchronisation(a),
  });
  return {};
});

/* Divers */

gerer("lien", async (url) => {
  ouvrirLien(String(url));
  return {};
});
// Mise à jour du logiciel : proposée au démarrage (src/main/maj.js), comme le launcher du jeu.
gerer("maj-verifier", async () => ({ nouvelle: ESSAI ? null : await maj.verifier() }));
gerer("maj-installer", async () => {
  await maj.installer((fait, total) => envoyer("maj-progression", { fait, total }));
  return {};
});

/* Mode d'essai : un serveur factice garni d'un faux contenu de jeu, et un dossier local d'exemple. */

function dossierEssaiLocal() {
  return path.join(os.tmpdir(), "lostisland-fichiers-essai", "pc", "modpack");
}

async function preparerEssai() {
  const base = path.join(os.tmpdir(), "lostisland-fichiers-essai");
  const racine = path.join(base, "serveur");
  const garnir = (dossier, fichiers) => {
    for (const [rel, taille] of Object.entries(fichiers)) {
      const f = path.join(dossier, ...rel.split("/"));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      if (!fs.existsSync(f)) fs.writeFileSync(f, Buffer.alloc(taille, rel.length));
    }
  };
  garnir(racine, {
    "mods/create-1.20.1-0.5.1.j.jar": 14_200_000,
    "mods/jei-1.20.1-forge-15.20.0.106.jar": 1_450_000,
    "mods/lostisland-core-0.4.2.jar": 860_000,
    "mods/sophisticatedbackpacks-1.20.1-3.20.17.jar": 2_100_000,
    "mods/farmersdelight-1.20.1-1.2.7.jar": 2_900_000,
    "mods/journeymap-1.20.1-5.10.3-forge.jar": 6_700_000,
    "optionalmod/sodium-ui-0.2.jar": 420_000,
    "optionalmod/shaders-pack-lite.jar": 3_600_000,
    "config/lostisland-common.toml": 4_200,
    "config/create-server.toml": 18_400,
    "resourcepacks/LostIsland-textures.zip": 48_000_000,
    "options.txt": 5_300,
  });
  garnir(path.join(base, "pc", "modpack"), {
    "mods/create-1.20.1-0.5.1.j.jar": 14_200_000,
    "mods/jei-1.20.1-forge-15.20.0.107.jar": 1_450_000,
    "mods/lostisland-core-0.4.3.jar": 870_000,
    "mods/farmersdelight-1.20.1-1.2.7.jar": 2_900_000,
    "mods/journeymap-1.20.1-5.10.3-forge.jar": 6_700_000,
    "optionalmod/sodium-ui-0.2.jar": 420_000,
    "config/lostisland-common.toml": 4_300,
    "config/create-server.toml": 18_400,
    "options.txt": 5_300,
    "Thumbs.db": 2_000,
  });
  fs.mkdirSync(path.join(base, "pc", "modpack", "kubejs", "scripts"), { recursive: true });
  const lenteur = Number(process.env.LI_ESSAI_LENTEUR) || 0;
  essai = await require("../../outils/serveur-factice").demarrer({ racine, comptes: { essai: "essai" }, lenteur });
}

function menu() {
  // macOS a besoin d'un menu Édition pour copier-coller dans les champs ; ailleurs, pas de menu.
  if (process.platform !== "darwin") return Menu.setApplicationMenu(null);
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]));
}

app.whenReady().then(async () => {
  menu();
  if (ESSAI) await preparerEssai();
  creerFenetre();
  // Essai sans écran : LI_CAPTURE=chemin.png photographie la fenêtre après LI_CAPTURE_MS ms, puis quitte.
  if (process.env.LI_CAPTURE) {
    setTimeout(async () => {
      // LI_SONDE (développement) : expression évaluée dans la page, résultat affiché dans le terminal.
      if (!app.isPackaged && process.env.LI_SONDE) console.log("[sonde]", JSON.stringify(await fenetre.webContents.executeJavaScript(process.env.LI_SONDE)));
      const img = await fenetre.webContents.capturePage();
      fs.writeFileSync(process.env.LI_CAPTURE, img.toPNG());
      app.exit(0);
    }, Number(process.env.LI_CAPTURE_MS) || 6000);
  }
});
app.on("window-all-closed", () => {
  fermerSession();
  essai?.fermer();
  app.quit();
});
app.on("activate", () => {
  if (!fenetre) creerFenetre();
});
