// Liste de mots français courants, sans accent, pour les phrases de passe (tirage uniforme : voir generator.js).
// La force réelle d'une phrase = nombre de mots × log2(taille de cette liste) : calculée à partir de la liste, jamais supposée.
const RAW = `
abeille acier agneau aigle aile aimant algue amande ami ananas ancre ange animal anneau arbre arche argent armoire arome arc arene aube avion avocat azur
bague balai balcon baleine bambou banane banc barque bassin bateau beurre biscuit blanc bleu bois boite bonbon botte bouche boule bouton branche bras brique brume buffet bulle
cabane cadeau cafe cage caillou calme camion canal canard canne carotte carte casque cassis cave cedre cerise chaine chaise chalet champ chant chapeau charbon chat chateau chene cheval chien chiffre cigale ciel cirque citron clair classe clef cloche clou cobra coeur colline comete corde corail corbeau crabe crayon creme cuisine cygne
dame danse dauphin delta dent desert dessin diamant digue doigt dome dragon drapeau eau echo eclair ecole ecran ecume elan elfe encre epice epee escargot espace etoile etang
fable falaise farine fee fenetre ferme feu feuille fil flamme fleur flute foret forge fort fougere fourmi fraise frere fromage fruit fumee galet gant gare gateau gazelle geant genou girafe glace globe gomme gorge graine grenier griffe grotte guepe guitare
habit halte hamac harpe herbe heron hibou hiver horloge houle hublot huile ile image iris ivoire jade jardin jaune jeton jonc joue jungle jupe kiwi koala
lac laine lampe lance lapin lave lierre lilas lime lion livre loup lueur lune lutin lynx magie maison mangue manteau marais marche marin masque matin melon menthe merle miel miroir moineau montagne moulin mouton muscle nacre neige nid noeud noir noix nuage nuit
ocean oeuf olive ombre onde opale orage orange orchidee orge ortie ours outil ouvert page paille panda panier papier papillon parc pelle pente perle phare piano pierre pigeon pin pinceau pirate piste plage plaine plume pluie poire poisson pole pomme pont porte poule prairie prune puits
quai quille radis rame raisin renard riviere robe robot roche roi rose roue rouge ruban ruche sable sac safran sage saule savon scie seau sel serpent singe sirop soie soleil sommet source souris sucre
table tapis tasse tente terre tigre tomate tonnerre tortue toucan tour train trefle tribu tulipe tunnel vague valise vallee velo velours verger verre vigne violet voile volcan vent vert wagon yacht zebre zero zinc
abri aiguille alpaga ardoise argile armure atlas aurore avoine axe badge balle ballon barre baton bec berger betail billet boeuf boucle bouee boussole brebis bride brise bronze brouillard bruyere buche
cabinet cactus cadre calepin canoe canyon capot carafe carnet carreau cascade casier cendre centre cerf chameau charrue chiot chocolat cidre cime citrouille clairon clavier clown cocon colibri collier commode compas concert coq coquille coton couteau couverture crepe crete cristal cuivre
dalle dattier debut dindon domino dune ecureuil eglise eleve emeraude enclume enigme epaule epine escalier etable etoffe eventail fanfare ferry fiole flacon flocon foin fontaine fosse foudre fouet fourche fournil frontiere fusee
gabarit galaxie galop garage gelee genet gerbe gilet glaive gobelet gondole gourde grange graphite gravier grelot grille guirlande hache hangar haricot hermine hirondelle hotte iceberg igloo indigo insecte jacinthe jarre jeudi jonquille journal judo kayak
lagune lamelle lanterne laurier lavande lessive levier liane lingot lotus louche lumiere luth macaron madrier maquis marbre marmotte mascotte mesange meteore minerai mirabelle moisson monture morille mouette mosaique nectar nenuphar noisette nougat
oasis obus oiseau opera oreille orfevre otarie ourson paon palmier pamplemousse parapluie parchemin pavot pelican pendule perroquet peuplier pivoine plateau plongeon pluvier poivre polaire pommier potiron poulain pylone quartz quetsche
rabot rayon rebond refuge relief rideau rocher romarin rosee rossignol roulotte sablier sapin sarcelle saumon scarabee sentier sequoia sillon sorbet souffle spirale stylo sucette sureau tamis tamarin tambour tarte tendre terrasse tilleul tirelire topaze tournesol traineau trompette truite tuile turquoise
urne vanille vapeur varech vergue vestiaire vigie vitrail voilier vitre vivier volant wapiti xylophone yaourt zeste zenith
`;

/** Mots uniques, en minuscules ASCII de 3 à 10 lettres. */
export const WORDS = Object.freeze([...new Set(RAW.split(/\s+/).filter((w) => /^[a-z]{3,10}$/.test(w)))]);
