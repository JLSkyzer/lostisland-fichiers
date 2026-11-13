// Réglages et compte retenu, dans le dossier de données du logiciel (userData).
// Le mot de passe n'est retenu que chiffré par le système (safeStorage : DPAPI, trousseau macOS, libsecret) ;
// sans chiffrement disponible, il n'est pas retenu du tout. Il n'est jamais écrit en clair, ni journalisé.
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const fichier = () => path.join(app.getPath("userData"), "reglages.json");

const DEFAUTS = {
  nom: "", // dernier nom de compte utilisé
  souvenir: false,
  motDePasse: null, // { v: base64 chiffré } quand « Se souvenir de moi » est coché
  dossierLocal: null, // dernier dossier ouvert côté PC
};

let cache = null;

function lire() {
  if (cache) return cache;
  try {
    cache = { ...DEFAUTS, ...JSON.parse(fs.readFileSync(fichier(), "utf8")) };
  } catch {
    cache = { ...DEFAUTS };
  }
  return cache;
}

function ecrire(modifs) {
  cache = { ...lire(), ...modifs };
  fs.mkdirSync(path.dirname(fichier()), { recursive: true });
  // Écriture atomique : un arrêt brutal ne laisse jamais un fichier à moitié écrit.
  const tmp = fichier() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, fichier());
  return cache;
}

const chiffrementDisponible = () => safeStorage.isEncryptionAvailable();

// Retient (ou oublie) le compte. Renvoie false si le système ne permet pas de chiffrer le mot de passe.
function retenir(nom, motDePasse, souvenir) {
  if (!souvenir || !chiffrementDisponible()) {
    ecrire({ nom, souvenir: false, motDePasse: null });
    return !souvenir;
  }
  ecrire({ nom, souvenir: true, motDePasse: { v: safeStorage.encryptString(motDePasse).toString("base64") } });
  return true;
}

function compteRetenu() {
  const r = lire();
  if (!r.souvenir || !r.motDePasse?.v || !r.nom) return null;
  try {
    return { nom: r.nom, motDePasse: safeStorage.decryptString(Buffer.from(r.motDePasse.v, "base64")) };
  } catch {
    return null; // chiffré sur une autre session ou une autre machine
  }
}

function oublierMotDePasse() {
  ecrire({ souvenir: false, motDePasse: null });
}

module.exports = { lire, ecrire, retenir, compteRetenu, oublierMotDePasse, chiffrementDisponible };
