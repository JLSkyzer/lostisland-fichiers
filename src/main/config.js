// Ce qui est fixe pour tout le monde.
const SITE = "https://lostisland.eriniumlab.com";

module.exports = {
  SITE,
  // API des fichiers du jeu (contrat : docs/api-logiciel-fichiers.md du dépôt du site).
  API: `${SITE}/api/fichiers`,
  // Page où l'administrateur crée les comptes d'accès.
  PAGE_ACCES: `${SITE}/admin/fichiers`,
  // Versions du logiciel : dépôt public, construites par sa CI.
  DEPOT: { owner: "JLSkyzer", repo: "lostisland-fichiers" },
};
