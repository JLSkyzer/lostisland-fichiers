// Envois en morceaux en cours, gardés sur disque pour reprendre après une coupure ou un redémarrage.
// Fichier JSON : { "<chemin distant>|<taille>|<date locale>": { id, cree } }. Le serveur efface les morceaux
// d'un envoi abandonné au bout d'un jour : au-delà, l'entrée ne sert plus et disparaît.
const fs = require("node:fs");
const path = require("node:path");

const DUREE = 24 * 3600 * 1000;

class Reprises {
  constructor(fichier) {
    this.fichier = fichier;
    this.donnees = null;
  }

  lire() {
    if (this.donnees) return this.donnees;
    try {
      this.donnees = JSON.parse(fs.readFileSync(this.fichier, "utf8"));
      if (!this.donnees || typeof this.donnees !== "object") this.donnees = {};
    } catch {
      this.donnees = {};
    }
    const maintenant = Date.now();
    for (const [cle, v] of Object.entries(this.donnees)) if (!v?.id || maintenant - (v.cree ?? 0) > DUREE) delete this.donnees[cle];
    return this.donnees;
  }

  ecrire() {
    fs.mkdirSync(path.dirname(this.fichier), { recursive: true });
    // Écriture atomique : un arrêt brutal ne laisse jamais un fichier à moitié écrit.
    const tmp = this.fichier + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.donnees, null, 1));
    fs.renameSync(tmp, this.fichier);
  }

  trouver(cle) {
    return this.lire()[cle]?.id ?? null;
  }

  garder(cle, id) {
    this.lire()[cle] = { id, cree: Date.now() };
    this.ecrire();
  }

  oublier(cle) {
    if (!(cle in this.lire())) return;
    delete this.donnees[cle];
    this.ecrire();
  }
}

module.exports = { Reprises };
