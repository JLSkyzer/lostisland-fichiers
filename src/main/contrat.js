// Règles du contrat de l'API (docs/api-logiciel-fichiers.md du site), en fonctions pures : aucune ne touche
// au réseau ni au disque, pour pouvoir les essayer seules (test/essai.js).
const crypto = require("node:crypto");

// Mêmes valeurs que la page Fichiers du jeu du site : Cloudflare refuse toute requête de plus de 100 Mo.
const MO = 1024 * 1024;
const SEUIL_MORCEAUX = 90 * MO; // au-delà, le fichier part en morceaux
const TAILLE_MORCEAU = 50 * MO;
const MORCEAUX_MAX = 2000; // refusé au-delà par le serveur (soit 100 Go)
const ID_ENVOI = /^[a-z0-9]{8,40}$/;

// Jamais envoyés : fichiers et dossiers cachés, et les fichiers que Windows dépose seul dans les dossiers.
const IGNORES = new Set(["thumbs.db", "desktop.ini"]);
function ignore(nom) {
  return nom.startsWith(".") || IGNORES.has(nom.toLowerCase());
}

// Nom accepté par le serveur (contenu.ts : cheminSur).
const NOM_INTERDIT = /[\\/:*?"<>|\u0000-\u001f]/;
function nomValide(nom) {
  return typeof nom === "string" && nom.length > 0 && nom.length <= 150 && nom !== "." && nom !== ".." && !nom.startsWith(".") && !NOM_INTERDIT.test(nom);
}
// Message d'explication si le nom est refusé, sinon null.
function refusNom(nom) {
  if (!nom || !nom.trim()) return "Le nom est vide.";
  if (nom.startsWith(".")) return "Un nom ne peut pas commencer par un point : le serveur refuse les fichiers cachés.";
  if (nom.length > 150) return "Nom trop long (150 caractères au plus).";
  if (NOM_INTERDIT.test(nom)) return "Ces caractères sont interdits dans un nom : \\ / : * ? \" < > |";
  return null;
}

// Chemin du serveur : relatif à la racine, séparé par « / », sans « / » au début ni à la fin ; "" est la racine.
function normaliser(chemin) {
  return String(chemin ?? "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("/");
}
function joindre(...parties) {
  return normaliser(parties.filter((p) => p !== "" && p != null).join("/"));
}
function parent(chemin) {
  const s = normaliser(chemin).split("/");
  s.pop();
  return s.join("/");
}
function nomDe(chemin) {
  return normaliser(chemin).split("/").pop() ?? "";
}

// Découpage : null si le fichier part d'une seule requête, sinon la liste des morceaux [début, fin[ .
function planMorceaux(taille, seuil = SEUIL_MORCEAUX, tailleMorceau = TAILLE_MORCEAU) {
  if (!Number.isFinite(taille) || taille < 0) throw new Error("Taille de fichier invalide.");
  if (taille <= seuil) return null;
  const n = Math.ceil(taille / tailleMorceau);
  if (n > MORCEAUX_MAX) throw new Error("Fichier trop gros : le serveur accepte 100 Go au plus.");
  return Array.from({ length: n }, (_, i) => ({ index: i, debut: i * tailleMorceau, fin: Math.min(taille, (i + 1) * tailleMorceau) }));
}

// Reprise : les morceaux à (r)envoyer, dans l'ordre. Ceux déjà reçus sont sautés, sauf le dernier, toujours
// envoyé en dernier puisque c'est lui qui déclenche l'assemblage.
function morceauxAEnvoyer(n, recus = []) {
  const deja = new Set(recus.filter((i) => Number.isInteger(i) && i >= 0 && i < n - 1));
  const r = [];
  for (let i = 0; i < n - 1; i++) if (!deja.has(i)) r.push(i);
  r.push(n - 1);
  return r;
}

// Identifiant d'envoi : 8 à 40 caractères [a-z0-9] ; 24 caractères tirés au hasard.
function nouvelIdEnvoi() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const octets = crypto.randomBytes(24);
  let id = "";
  for (const o of octets) id += alphabet[o % alphabet.length];
  return id;
}

// Clé d'un envoi à reprendre : même destination, même taille, même date de modification locale. Si le fichier
// local a changé entre-temps, la clé change et l'envoi repart de zéro.
function cleReprise(cheminDistant, taille, modifieMs) {
  return `${normaliser(cheminDistant)}|${taille}|${Math.trunc(modifieMs)}`;
}

/* Synchronisation, du dossier local vers le dossier serveur.
   local   : [{ chemin, taille, sha1? }]  chemins relatifs au dossier local (séparés par « / »), sans les ignorés
   distant : [{ chemin, taille, sha1 }]   GET /liste?recursif=1
   dossiersLocaux : chemins relatifs des dossiers locaux (pour supprimer d'un coup un dossier absent en local)
   Le sha1 local n'est nécessaire que pour les fichiers de même taille que leur pendant distant
   (voir aHacher) : une taille différente suffit à dire qu'ils diffèrent. */
function aHacher(local, distant) {
  const d = new Map(distant.map((f) => [f.chemin, f]));
  return local.filter((f) => d.has(f.chemin) && d.get(f.chemin).taille === f.taille).map((f) => f.chemin);
}

function apercuSync(local, distant, { supprimer = true, dossiersLocaux = [] } = {}) {
  const d = new Map(distant.map((f) => [f.chemin, f]));
  const l = new Map(local.map((f) => [f.chemin, f]));
  const envoyer = [];
  const remplacer = [];
  let identiques = 0;
  for (const f of local) {
    const autre = d.get(f.chemin);
    if (!autre) envoyer.push(f);
    else if (autre.taille !== f.taille) remplacer.push(f);
    else if (f.sha1 == null) throw new Error(`Empreinte locale manquante pour ${f.chemin}.`);
    else if (f.sha1.toLowerCase() !== String(autre.sha1).toLowerCase()) remplacer.push(f);
    else identiques++;
  }
  const aSupprimer = supprimer ? distant.filter((f) => !l.has(f.chemin)) : [];
  const tri = (a, b) => a.chemin.localeCompare(b.chemin, "fr");
  return {
    envoyer: envoyer.sort(tri),
    remplacer: remplacer.sort(tri),
    supprimer: aSupprimer.sort(tri),
    // Suppressions réellement faites : un dossier distant absent en local part d'un coup.
    suppressions: regrouperSuppressions(aSupprimer.map((f) => f.chemin), dossiersLocaux, local.map((f) => f.chemin)),
    identiques,
    octets: [...envoyer, ...remplacer].reduce((s, f) => s + f.taille, 0),
  };
}

// Pour chaque fichier à supprimer : le plus haut de ses dossiers qui n'existe pas en local, sinon le fichier.
function regrouperSuppressions(fichiers, dossiersLocaux = [], fichiersLocaux = []) {
  const presents = new Set(dossiersLocaux.map(normaliser));
  for (const f of fichiersLocaux) {
    const s = normaliser(f).split("/");
    for (let i = 1; i < s.length; i++) presents.add(s.slice(0, i).join("/"));
  }
  const r = new Set();
  for (const f of fichiers) {
    const s = normaliser(f).split("/");
    let cible = s.join("/");
    for (let i = 1; i < s.length; i++) {
      const dossier = s.slice(0, i).join("/");
      if (!presents.has(dossier)) {
        cible = dossier;
        break;
      }
    }
    r.add(cible);
  }
  // Rien en double : un chemin couvert par un dossier déjà supprimé disparaît.
  const liste = [...r].sort();
  return liste.filter((c) => !liste.some((autre) => autre !== c && c.startsWith(autre + "/")));
}

// Vitesse sur une fenêtre glissante : points [{ t (ms), octets cumulés }].
function vitesse(points, maintenant, fenetre = 3000) {
  const recents = points.filter((p) => maintenant - p.t <= fenetre);
  if (recents.length < 2) return 0;
  const a = recents[0];
  const b = recents[recents.length - 1];
  return b.t > a.t ? ((b.octets - a.octets) * 1000) / (b.t - a.t) : 0;
}

/* Messages d'erreur en français. */
const RESEAU = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ECONNABORTED", "EPIPE", "ESOCKETTIMEDOUT", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);
function messageSysteme(e) {
  switch (e?.code) {
    case "ENOSPC":
      return "Plus de place sur le disque.";
    case "EBUSY":
    case "EPERM":
      return "Fichier verrouillé ou utilisé par un autre programme : fermez-le, puis réessayez.";
    case "EACCES":
      return "Accès refusé à ce fichier ou dossier.";
    case "ENOENT":
      return "Fichier ou dossier introuvable : il a peut-être été déplacé ou supprimé.";
    case "EEXIST":
      return "Un élément porte déjà ce nom.";
    case "ENOTEMPTY":
      return "Le dossier n'est pas vide.";
    case "EISDIR":
      return "Un dossier porte déjà ce nom.";
    case "ENAMETOOLONG":
      return "Chemin trop long pour le système.";
    default:
      if (RESEAU.has(e?.code)) return "Site injoignable : vérifiez la connexion à internet, puis réessayez.";
      return null;
  }
}

function messageHttp(statut, erreurServeur) {
  if (statut === 401 || statut === 403) return erreurServeur || "Nom ou mot de passe incorrect.";
  if (statut === 413) return "Requête trop grosse pour le site (limite de Cloudflare).";
  if (statut === 429) return "Trop de requêtes : patientez un instant, puis réessayez.";
  if (statut === 507) return "Plus de place sur le serveur.";
  if (erreurServeur) return erreurServeur;
  if (statut >= 500) return `Le site ne répond pas correctement pour l'instant (erreur ${statut}). Réessayez dans un instant.`;
  return `Le site a refusé la demande (erreur ${statut}).`;
}

// Une erreur vaut-elle un nouvel essai ? Réseau coupé, délai dépassé, serveur ou Cloudflare indisponible.
function aRetenter(e) {
  if (e?.name === "AbortError") return false;
  if (e?.statut) return e.statut >= 500 || e.statut === 408 || e.statut === 429;
  return RESEAU.has(e?.code) || e?.code === "ERR_STREAM_PREMATURE_CLOSE" || e?.code === "ECONNRESET";
}

module.exports = {
  MO,
  SEUIL_MORCEAUX,
  TAILLE_MORCEAU,
  MORCEAUX_MAX,
  ID_ENVOI,
  ignore,
  nomValide,
  refusNom,
  normaliser,
  joindre,
  parent,
  nomDe,
  planMorceaux,
  morceauxAEnvoyer,
  nouvelIdEnvoi,
  cleReprise,
  aHacher,
  apercuSync,
  regrouperSuppressions,
  vitesse,
  messageSysteme,
  messageHttp,
  aRetenter,
};
