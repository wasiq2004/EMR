/**
 * A curated ICD-10 subset for Indian outpatient practice.
 *
 * ON THE SIZE OF THIS LIST — read this before "completing" it.
 *
 * The plan called for roughly 1,500 codes. This is about 210, and that is a
 * deliberate decision rather than an unfinished job. ICD-10 codes written into a
 * clinical record are not decoration: they travel onto insurance claims, into
 * ABDM, and into whatever the next clinician reads. A wrong code is worse than
 * no code, because free text is self-evidently a clinician's own words while a
 * code carries the authority of a standard. Every entry below is one we are
 * confident of; padding the list to a target by guessing at codes would trade a
 * visible gap for an invisible error, which is the wrong trade in a medical
 * record.
 *
 * The gap is covered three ways, none of which involves guessing:
 *   1. Free text is always available and always has been — `condition.code` is
 *      nullable and the typeahead never blocks an unmatched entry.
 *   2. A clinic can add its own rows, which is what `isActive` and the per-clinic
 *      rows are for.
 *   3. `scripts/import-diagnosis-catalogue.mjs` loads a full licensed ICD-10
 *      release from CSV. Obtaining that release is a procurement decision, the
 *      same way replacing the drug catalogue with a licensed formulary is.
 *
 * ON WHAT IS IN IT. The selection is what a 1–5 doctor Indian OPD actually sees,
 * so it is heavy on vector-borne fever, tuberculosis, nutritional deficiency and
 * the metabolic cluster, and it includes almost no inpatient, surgical or
 * oncological codes. Searching "fever" in the full seventy-thousand-code set
 * returns dozens of qualifiers nobody at an outpatient desk will use and buries
 * the one they want — curation is what makes a typeahead usable, not a
 * limitation of it.
 *
 * Codes are WHO ICD-10, not ICD-10-CM. The two diverge (ICD-10-CM has R11.10
 * for vomiting where WHO has R11 for nausea and vomiting), and mixing them
 * produces records that validate against neither.
 *
 * `synonyms` exists because what a doctor types is not what should be printed.
 * "URTI" has to find the entry; "Acute upper respiratory infection" is what goes
 * on the prescription.
 */

export interface DiagnosisSeed {
  code: string;
  display: string;
  category: string;
  /** Ordinarily long-term, so the chronic flag is pre-ticked. Still editable. */
  chronic?: true;
  synonyms?: string;
}

const SYSTEM = 'http://hl7.org/fhir/sid/icd-10';

export const DIAGNOSIS_CODE_SYSTEM = SYSTEM;
export const DIAGNOSIS_CATALOGUE_VERSION = 'icd10-opd-in-v1';

export const DIAGNOSIS_CATALOGUE: DiagnosisSeed[] = [
  /* --- Respiratory ------------------------------------------------------- */
  { code: 'J06.9', display: 'Acute upper respiratory infection', category: 'Respiratory', synonyms: 'urti uri upper respiratory tract infection' },
  { code: 'J00', display: 'Acute nasopharyngitis (common cold)', category: 'Respiratory', synonyms: 'cold coryza' },
  { code: 'J02.9', display: 'Acute pharyngitis', category: 'Respiratory', synonyms: 'sore throat throat pain' },
  { code: 'J03.9', display: 'Acute tonsillitis', category: 'Respiratory', synonyms: 'tonsils' },
  { code: 'J01.9', display: 'Acute sinusitis', category: 'Respiratory', synonyms: 'sinus' },
  { code: 'J32.9', display: 'Chronic sinusitis', category: 'Respiratory', chronic: true },
  { code: 'J31.0', display: 'Chronic rhinitis', category: 'Respiratory', chronic: true },
  { code: 'J30.4', display: 'Allergic rhinitis', category: 'Respiratory', synonyms: 'hay fever nasal allergy' },
  { code: 'J20.9', display: 'Acute bronchitis', category: 'Respiratory' },
  { code: 'J40', display: 'Bronchitis, not specified as acute or chronic', category: 'Respiratory' },
  { code: 'J21.9', display: 'Acute bronchiolitis', category: 'Respiratory', synonyms: 'bronchiolitis infant wheeze' },
  { code: 'J18.9', display: 'Pneumonia, unspecified organism', category: 'Respiratory', synonyms: 'chest infection' },
  { code: 'J45.9', display: 'Asthma', category: 'Respiratory', synonyms: 'wheeze reactive airway' },
  { code: 'J44.9', display: 'Chronic obstructive pulmonary disease', category: 'Respiratory', chronic: true, synonyms: 'copd emphysema' },
  { code: 'J11.1', display: 'Influenza with respiratory manifestations, virus not identified', category: 'Respiratory', synonyms: 'flu influenza' },
  { code: 'J35.0', display: 'Chronic tonsillitis', category: 'Respiratory', chronic: true },
  { code: 'J38.1', display: 'Polyp of vocal cord and larynx', category: 'Respiratory' },
  { code: 'J04.0', display: 'Acute laryngitis', category: 'Respiratory', synonyms: 'hoarseness voice' },
  { code: 'R05', display: 'Cough', category: 'Symptoms', synonyms: 'coughing' },
  { code: 'R06.0', display: 'Dyspnoea', category: 'Symptoms', synonyms: 'breathlessness shortness of breath sob' },
  { code: 'R04.0', display: 'Epistaxis', category: 'Symptoms', synonyms: 'nose bleed nosebleed' },

  /* --- Tuberculosis ------------------------------------------------------ */
  { code: 'A15.0', display: 'Tuberculosis of lung, confirmed', category: 'Tuberculosis', chronic: true, synonyms: 'ptb pulmonary tb koch' },
  { code: 'A16.2', display: 'Tuberculosis of lung, without mention of confirmation', category: 'Tuberculosis', chronic: true, synonyms: 'tb clinically diagnosed' },
  { code: 'A18.2', display: 'Tuberculous peripheral lymphadenopathy', category: 'Tuberculosis', chronic: true, synonyms: 'tb lymph node cervical' },
  { code: 'A17.0', display: 'Tuberculous meningitis', category: 'Tuberculosis', chronic: true },
  { code: 'A19.9', display: 'Miliary tuberculosis, unspecified', category: 'Tuberculosis', chronic: true },

  /* --- Vector-borne and other infections --------------------------------- */
  { code: 'A90', display: 'Dengue fever', category: 'Infectious', synonyms: 'dengue' },
  { code: 'A91', display: 'Dengue haemorrhagic fever', category: 'Infectious', synonyms: 'dhf severe dengue' },
  { code: 'A92.0', display: 'Chikungunya virus disease', category: 'Infectious', synonyms: 'chikungunya' },
  { code: 'B50.9', display: 'Plasmodium falciparum malaria', category: 'Infectious', synonyms: 'malaria falciparum pf' },
  { code: 'B51.9', display: 'Plasmodium vivax malaria', category: 'Infectious', synonyms: 'malaria vivax pv' },
  { code: 'B54', display: 'Unspecified malaria', category: 'Infectious', synonyms: 'malaria' },
  { code: 'A01.0', display: 'Typhoid fever', category: 'Infectious', synonyms: 'typhoid enteric fever salmonella' },
  { code: 'A27.9', display: 'Leptospirosis', category: 'Infectious', synonyms: 'lepto' },
  { code: 'A75.9', display: 'Typhus fever, unspecified', category: 'Infectious', synonyms: 'scrub typhus rickettsia' },
  { code: 'B34.9', display: 'Viral infection, unspecified site', category: 'Infectious', synonyms: 'viral fever viral illness' },
  { code: 'A09', display: 'Infectious gastroenteritis and colitis', category: 'Gastrointestinal', synonyms: 'gastroenteritis food poisoning loose motions diarrhoea' },
  { code: 'A08.4', display: 'Viral intestinal infection, unspecified', category: 'Gastrointestinal', synonyms: 'viral diarrhoea rotavirus' },
  { code: 'A03.9', display: 'Shigellosis, unspecified', category: 'Gastrointestinal', synonyms: 'bacillary dysentery' },
  { code: 'A06.0', display: 'Acute amoebic dysentery', category: 'Gastrointestinal', synonyms: 'amoebiasis entamoeba' },
  { code: 'A00.9', display: 'Cholera, unspecified', category: 'Infectious' },
  { code: 'B82.9', display: 'Intestinal parasitism, unspecified', category: 'Gastrointestinal', synonyms: 'worms helminthiasis' },
  { code: 'B77.9', display: 'Ascariasis without complications', category: 'Gastrointestinal', synonyms: 'roundworm' },
  { code: 'B05.9', display: 'Measles without complication', category: 'Infectious', synonyms: 'measles rubeola' },
  { code: 'B06.9', display: 'Rubella without complication', category: 'Infectious', synonyms: 'german measles' },
  { code: 'B01.9', display: 'Varicella without complication', category: 'Infectious', synonyms: 'chickenpox chicken pox' },
  { code: 'B02.9', display: 'Zoster without complication', category: 'Infectious', synonyms: 'shingles herpes zoster' },
  { code: 'B00.1', display: 'Herpesviral vesicular dermatitis', category: 'Infectious', synonyms: 'cold sore herpes labialis' },
  { code: 'B26.9', display: 'Mumps without complication', category: 'Infectious', synonyms: 'mumps parotitis' },
  { code: 'B08.4', display: 'Enteroviral vesicular stomatitis with exanthem', category: 'Infectious', synonyms: 'hand foot and mouth disease hfmd' },
  { code: 'A37.9', display: 'Whooping cough, unspecified species', category: 'Infectious', synonyms: 'pertussis' },
  { code: 'A36.9', display: 'Diphtheria, unspecified', category: 'Infectious' },
  { code: 'A35', display: 'Other tetanus', category: 'Infectious', synonyms: 'tetanus' },
  { code: 'B15.9', display: 'Hepatitis A without hepatic coma', category: 'Infectious', synonyms: 'hepatitis a jaundice hav' },
  { code: 'B16.9', display: 'Acute hepatitis B without delta-agent or hepatic coma', category: 'Infectious', synonyms: 'hepatitis b hbv' },
  { code: 'B17.1', display: 'Acute hepatitis C', category: 'Infectious', synonyms: 'hepatitis c hcv' },
  { code: 'B19.9', display: 'Unspecified viral hepatitis without hepatic coma', category: 'Infectious', synonyms: 'viral hepatitis jaundice' },
  { code: 'B24', display: 'Unspecified HIV disease', category: 'Infectious', chronic: true, synonyms: 'hiv aids retroviral' },
  { code: 'A49.9', display: 'Bacterial infection, unspecified', category: 'Infectious' },
  { code: 'A46', display: 'Erysipelas', category: 'Skin' },
  { code: 'A30.9', display: 'Leprosy, unspecified', category: 'Infectious', chronic: true, synonyms: 'leprosy hansen' },
  { code: 'B55.9', display: 'Leishmaniasis, unspecified', category: 'Infectious', synonyms: 'kala azar' },
  { code: 'B74.9', display: 'Filariasis, unspecified', category: 'Infectious', synonyms: 'filaria elephantiasis' },
  { code: 'A82.9', display: 'Rabies, unspecified', category: 'Infectious' },
  { code: 'Z20.3', display: 'Contact with and exposure to rabies', category: 'Encounters', synonyms: 'dog bite animal bite rabies exposure' },

  /* --- Fever and general symptoms ---------------------------------------- */
  { code: 'R50.9', display: 'Fever, unspecified', category: 'Symptoms', synonyms: 'fever pyrexia temperature' },
  { code: 'R50.2', display: 'Drug-induced fever', category: 'Symptoms' },
  { code: 'R51', display: 'Headache', category: 'Symptoms', synonyms: 'head pain cephalgia' },
  { code: 'R53', display: 'Malaise and fatigue', category: 'Symptoms', synonyms: 'tiredness weakness lethargy' },
  { code: 'R42', display: 'Dizziness and giddiness', category: 'Symptoms', synonyms: 'giddiness lightheaded' },
  { code: 'R55', display: 'Syncope and collapse', category: 'Symptoms', synonyms: 'fainting blackout' },
  { code: 'R63.0', display: 'Anorexia', category: 'Symptoms', synonyms: 'loss of appetite poor appetite' },
  { code: 'R63.4', display: 'Abnormal weight loss', category: 'Symptoms', synonyms: 'weight loss' },
  { code: 'R63.5', display: 'Abnormal weight gain', category: 'Symptoms', synonyms: 'weight gain' },
  { code: 'R60.0', display: 'Localised oedema', category: 'Symptoms', synonyms: 'swelling oedema edema' },
  { code: 'R21', display: 'Rash and other nonspecific skin eruption', category: 'Symptoms', synonyms: 'rash skin eruption' },
  { code: 'R22.9', display: 'Localised swelling, mass or lump, unspecified', category: 'Symptoms', synonyms: 'lump swelling mass' },
  { code: 'R59.0', display: 'Localised enlarged lymph nodes', category: 'Symptoms', synonyms: 'lymphadenopathy glands' },
  { code: 'R07.4', display: 'Chest pain, unspecified', category: 'Symptoms', synonyms: 'chest pain' },
  { code: 'R10.4', display: 'Other and unspecified abdominal pain', category: 'Symptoms', synonyms: 'abdominal pain stomach pain tummy pain' },
  { code: 'R10.1', display: 'Pain localised to upper abdomen', category: 'Symptoms', synonyms: 'epigastric pain upper abdominal pain' },
  { code: 'R10.3', display: 'Pain localised to other parts of lower abdomen', category: 'Symptoms', synonyms: 'lower abdominal pain' },
  { code: 'R11', display: 'Nausea and vomiting', category: 'Symptoms', synonyms: 'vomiting nausea emesis' },
  { code: 'R19.7', display: 'Diarrhoea, unspecified', category: 'Symptoms', synonyms: 'loose stools loose motions' },
  { code: 'R35', display: 'Polyuria', category: 'Symptoms', synonyms: 'frequent urination frequency nocturia' },
  { code: 'R30.0', display: 'Dysuria', category: 'Symptoms', synonyms: 'burning urination painful urination' },
  { code: 'R31', display: 'Unspecified haematuria', category: 'Symptoms', synonyms: 'blood in urine' },
  { code: 'R73.0', display: 'Abnormal glucose tolerance test', category: 'Endocrine', synonyms: 'prediabetes impaired glucose tolerance igt' },
  { code: 'R73.9', display: 'Hyperglycaemia, unspecified', category: 'Endocrine', synonyms: 'high sugar raised blood sugar' },

  /* --- Metabolic and endocrine ------------------------------------------- */
  { code: 'E11.9', display: 'Type 2 diabetes mellitus without complications', category: 'Endocrine', chronic: true, synonyms: 'diabetes dm t2dm sugar niddm' },
  { code: 'E11.2', display: 'Type 2 diabetes mellitus with renal complications', category: 'Endocrine', chronic: true, synonyms: 'diabetic nephropathy' },
  { code: 'E11.3', display: 'Type 2 diabetes mellitus with ophthalmic complications', category: 'Endocrine', chronic: true, synonyms: 'diabetic retinopathy' },
  { code: 'E11.4', display: 'Type 2 diabetes mellitus with neurological complications', category: 'Endocrine', chronic: true, synonyms: 'diabetic neuropathy' },
  { code: 'E10.9', display: 'Type 1 diabetes mellitus without complications', category: 'Endocrine', chronic: true, synonyms: 'type 1 diabetes iddm' },
  { code: 'O24.4', display: 'Diabetes mellitus arising in pregnancy', category: 'Obstetric', synonyms: 'gestational diabetes gdm' },
  { code: 'E16.2', display: 'Hypoglycaemia, unspecified', category: 'Endocrine', synonyms: 'low sugar hypoglycemia' },
  { code: 'E03.9', display: 'Hypothyroidism, unspecified', category: 'Endocrine', chronic: true, synonyms: 'hypothyroid thyroid low' },
  { code: 'E05.9', display: 'Thyrotoxicosis, unspecified', category: 'Endocrine', chronic: true, synonyms: 'hyperthyroid thyrotoxicosis graves' },
  { code: 'E04.9', display: 'Nontoxic goitre, unspecified', category: 'Endocrine', synonyms: 'goitre thyroid swelling' },
  { code: 'E06.3', display: 'Autoimmune thyroiditis', category: 'Endocrine', chronic: true, synonyms: 'hashimoto thyroiditis' },
  { code: 'E78.5', display: 'Hyperlipidaemia, unspecified', category: 'Endocrine', chronic: true, synonyms: 'dyslipidaemia high cholesterol lipids' },
  { code: 'E78.0', display: 'Pure hypercholesterolaemia', category: 'Endocrine', chronic: true, synonyms: 'high cholesterol' },
  { code: 'E78.1', display: 'Pure hyperglyceridaemia', category: 'Endocrine', chronic: true, synonyms: 'high triglycerides' },
  { code: 'E66.9', display: 'Obesity, unspecified', category: 'Endocrine', chronic: true, synonyms: 'obesity overweight' },
  { code: 'E28.2', display: 'Polycystic ovarian syndrome', category: 'Gynaecological', chronic: true, synonyms: 'pcos pcod' },
  { code: 'E55.9', display: 'Vitamin D deficiency, unspecified', category: 'Nutritional', synonyms: 'vitamin d deficiency vit d' },
  { code: 'E53.8', display: 'Deficiency of other specified B group vitamins', category: 'Nutritional', synonyms: 'b12 deficiency vitamin b12' },
  { code: 'E61.1', display: 'Iron deficiency', category: 'Nutritional', synonyms: 'iron deficiency' },
  { code: 'E46', display: 'Unspecified protein-energy malnutrition', category: 'Nutritional', synonyms: 'malnutrition undernutrition' },
  { code: 'E43', display: 'Unspecified severe protein-energy malnutrition', category: 'Nutritional', synonyms: 'severe malnutrition sam marasmus' },
  { code: 'E86', display: 'Volume depletion', category: 'Nutritional', synonyms: 'dehydration' },
  { code: 'E87.6', display: 'Hypokalaemia', category: 'Metabolic', synonyms: 'low potassium' },
  { code: 'E87.1', display: 'Hypo-osmolality and hyponatraemia', category: 'Metabolic', synonyms: 'low sodium hyponatremia' },

  /* --- Cardiovascular ---------------------------------------------------- */
  { code: 'I10', display: 'Essential (primary) hypertension', category: 'Cardiovascular', chronic: true, synonyms: 'hypertension htn high bp blood pressure' },
  { code: 'I15.9', display: 'Secondary hypertension, unspecified', category: 'Cardiovascular', chronic: true },
  { code: 'I20.9', display: 'Angina pectoris, unspecified', category: 'Cardiovascular', chronic: true, synonyms: 'angina chest pain cardiac' },
  { code: 'I25.9', display: 'Chronic ischaemic heart disease, unspecified', category: 'Cardiovascular', chronic: true, synonyms: 'ihd cad coronary artery disease' },
  { code: 'I21.9', display: 'Acute myocardial infarction, unspecified', category: 'Cardiovascular', synonyms: 'heart attack mi' },
  { code: 'I50.9', display: 'Heart failure, unspecified', category: 'Cardiovascular', chronic: true, synonyms: 'ccf heart failure chf' },
  { code: 'I48', display: 'Atrial fibrillation and flutter', category: 'Cardiovascular', chronic: true, synonyms: 'af atrial fibrillation' },
  { code: 'I49.9', display: 'Cardiac arrhythmia, unspecified', category: 'Cardiovascular', synonyms: 'palpitations arrhythmia' },
  { code: 'R00.2', display: 'Palpitations', category: 'Symptoms', synonyms: 'palpitations heart racing' },
  { code: 'I05.9', display: 'Rheumatic mitral valve disease, unspecified', category: 'Cardiovascular', chronic: true, synonyms: 'rheumatic heart disease rhd mitral' },
  { code: 'I64', display: 'Stroke, not specified as haemorrhage or infarction', category: 'Neurological', synonyms: 'stroke cva' },
  { code: 'I63.9', display: 'Cerebral infarction, unspecified', category: 'Neurological', synonyms: 'ischaemic stroke infarct' },
  { code: 'G45.9', display: 'Transient cerebral ischaemic attack, unspecified', category: 'Neurological', synonyms: 'tia mini stroke' },
  { code: 'I83.9', display: 'Varicose veins of lower extremities', category: 'Cardiovascular', chronic: true, synonyms: 'varicose veins' },
  { code: 'I80.2', display: 'Phlebitis and thrombophlebitis of deep vessels of lower extremities', category: 'Cardiovascular', synonyms: 'dvt deep vein thrombosis' },
  { code: 'I99', display: 'Other and unspecified disorders of circulatory system', category: 'Cardiovascular' },

  /* --- Haematology -------------------------------------------------------- */
  { code: 'D50.9', display: 'Iron deficiency anaemia, unspecified', category: 'Haematological', synonyms: 'anaemia anemia ida low haemoglobin' },
  { code: 'D51.9', display: 'Vitamin B12 deficiency anaemia, unspecified', category: 'Haematological', synonyms: 'b12 anaemia megaloblastic' },
  { code: 'D52.9', display: 'Folate deficiency anaemia, unspecified', category: 'Haematological', synonyms: 'folate anaemia folic acid' },
  { code: 'D64.9', display: 'Anaemia, unspecified', category: 'Haematological', synonyms: 'anaemia anemia' },
  { code: 'D56.9', display: 'Thalassaemia, unspecified', category: 'Haematological', chronic: true, synonyms: 'thalassaemia thalassemia' },
  { code: 'D57.1', display: 'Sickle-cell disease without crisis', category: 'Haematological', chronic: true, synonyms: 'sickle cell' },
  { code: 'D69.6', display: 'Thrombocytopenia, unspecified', category: 'Haematological', synonyms: 'low platelets thrombocytopenia' },

  /* --- Gastrointestinal and hepatobiliary -------------------------------- */
  { code: 'K29.7', display: 'Gastritis, unspecified', category: 'Gastrointestinal', synonyms: 'gastritis acidity' },
  { code: 'K30', display: 'Dyspepsia', category: 'Gastrointestinal', synonyms: 'indigestion dyspepsia gas acidity' },
  { code: 'K21.0', display: 'Gastro-oesophageal reflux disease with oesophagitis', category: 'Gastrointestinal', chronic: true, synonyms: 'gerd reflux oesophagitis' },
  { code: 'K21.9', display: 'Gastro-oesophageal reflux disease without oesophagitis', category: 'Gastrointestinal', chronic: true, synonyms: 'gerd reflux heartburn' },
  { code: 'K25.9', display: 'Gastric ulcer, unspecified', category: 'Gastrointestinal', synonyms: 'gastric ulcer peptic ulcer' },
  { code: 'K26.9', display: 'Duodenal ulcer, unspecified', category: 'Gastrointestinal', synonyms: 'duodenal ulcer' },
  { code: 'K59.0', display: 'Constipation', category: 'Gastrointestinal', synonyms: 'constipation hard stools' },
  { code: 'K58.9', display: 'Irritable bowel syndrome without diarrhoea', category: 'Gastrointestinal', chronic: true, synonyms: 'ibs irritable bowel' },
  { code: 'K52.9', display: 'Noninfective gastroenteritis and colitis, unspecified', category: 'Gastrointestinal' },
  { code: 'K64.9', display: 'Haemorrhoids, unspecified', category: 'Gastrointestinal', synonyms: 'piles haemorrhoids hemorrhoids' },
  { code: 'K60.2', display: 'Anal fissure, unspecified', category: 'Gastrointestinal', synonyms: 'fissure anal fissure' },
  { code: 'K61.0', display: 'Anal abscess', category: 'Gastrointestinal' },
  { code: 'K80.2', display: 'Calculus of gallbladder without cholecystitis', category: 'Gastrointestinal', synonyms: 'gallstones cholelithiasis' },
  { code: 'K81.9', display: 'Cholecystitis, unspecified', category: 'Gastrointestinal', synonyms: 'cholecystitis gallbladder' },
  { code: 'K76.0', display: 'Fatty (change of) liver', category: 'Gastrointestinal', chronic: true, synonyms: 'fatty liver nafld hepatic steatosis' },
  { code: 'K74.6', display: 'Other and unspecified cirrhosis of liver', category: 'Gastrointestinal', chronic: true, synonyms: 'cirrhosis liver disease' },
  { code: 'K85.9', display: 'Acute pancreatitis, unspecified', category: 'Gastrointestinal', synonyms: 'pancreatitis' },
  { code: 'K42.9', display: 'Umbilical hernia without obstruction or gangrene', category: 'Gastrointestinal', synonyms: 'umbilical hernia' },
  { code: 'K40.9', display: 'Unilateral inguinal hernia without obstruction or gangrene', category: 'Gastrointestinal', synonyms: 'inguinal hernia' },
  { code: 'K02.9', display: 'Dental caries, unspecified', category: 'Dental', synonyms: 'caries tooth decay cavity' },
  { code: 'K05.1', display: 'Chronic gingivitis', category: 'Dental', synonyms: 'gingivitis gum disease' },
  { code: 'K12.1', display: 'Other forms of stomatitis', category: 'Dental', synonyms: 'mouth ulcer stomatitis aphthous' },
  { code: 'K11.2', display: 'Sialoadenitis', category: 'Dental', synonyms: 'salivary gland infection' },
  { code: 'R17', display: 'Unspecified jaundice', category: 'Symptoms', synonyms: 'jaundice icterus yellow' },

  /* --- Renal and urology -------------------------------------------------- */
  { code: 'N39.0', display: 'Urinary tract infection, site not specified', category: 'Renal', synonyms: 'uti urine infection' },
  { code: 'N30.0', display: 'Acute cystitis', category: 'Renal', synonyms: 'cystitis bladder infection' },
  { code: 'N10', display: 'Acute tubulo-interstitial nephritis', category: 'Renal', synonyms: 'pyelonephritis kidney infection' },
  { code: 'N20.0', display: 'Calculus of kidney', category: 'Renal', synonyms: 'kidney stone renal calculus nephrolithiasis' },
  { code: 'N20.1', display: 'Calculus of ureter', category: 'Renal', synonyms: 'ureteric stone' },
  { code: 'N18.9', display: 'Chronic kidney disease, unspecified', category: 'Renal', chronic: true, synonyms: 'ckd renal failure kidney disease' },
  { code: 'N17.9', display: 'Acute kidney failure, unspecified', category: 'Renal', synonyms: 'aki acute renal failure' },
  { code: 'N40', display: 'Hyperplasia of prostate', category: 'Urology', chronic: true, synonyms: 'bph prostate enlargement' },
  { code: 'N41.0', display: 'Acute prostatitis', category: 'Urology', synonyms: 'prostatitis' },
  { code: 'N43.3', display: 'Hydrocele, unspecified', category: 'Urology', synonyms: 'hydrocele' },
  { code: 'N45.9', display: 'Orchitis and epididymitis', category: 'Urology', synonyms: 'epididymitis orchitis' },
  { code: 'N47', display: 'Redundant prepuce, phimosis and paraphimosis', category: 'Urology', synonyms: 'phimosis' },
  { code: 'N48.1', display: 'Balanoposthitis', category: 'Urology', synonyms: 'balanitis' },

  /* --- Gynaecology and obstetrics ---------------------------------------- */
  { code: 'Z34.9', display: 'Supervision of normal pregnancy, unspecified', category: 'Obstetric', synonyms: 'antenatal anc pregnancy checkup' },
  { code: 'Z32.0', display: 'Pregnancy, not yet confirmed', category: 'Obstetric', synonyms: 'suspected pregnancy' },
  { code: 'O21.0', display: 'Mild hyperemesis gravidarum', category: 'Obstetric', synonyms: 'vomiting in pregnancy morning sickness' },
  { code: 'O16', display: 'Unspecified maternal hypertension', category: 'Obstetric', synonyms: 'pregnancy hypertension pih' },
  { code: 'O99.0', display: 'Anaemia complicating pregnancy, childbirth and the puerperium', category: 'Obstetric', synonyms: 'anaemia in pregnancy' },
  { code: 'N92.0', display: 'Excessive and frequent menstruation with regular cycle', category: 'Gynaecological', synonyms: 'menorrhagia heavy periods' },
  { code: 'N92.6', display: 'Irregular menstruation, unspecified', category: 'Gynaecological', synonyms: 'irregular periods' },
  { code: 'N91.2', display: 'Amenorrhoea, unspecified', category: 'Gynaecological', synonyms: 'amenorrhoea no periods missed period' },
  { code: 'N94.6', display: 'Dysmenorrhoea, unspecified', category: 'Gynaecological', synonyms: 'period pain dysmenorrhoea cramps' },
  { code: 'N95.1', display: 'Menopausal and female climacteric states', category: 'Gynaecological', synonyms: 'menopause hot flushes' },
  { code: 'N76.0', display: 'Acute vaginitis', category: 'Gynaecological', synonyms: 'vaginitis' },
  { code: 'N89.8', display: 'Other specified noninflammatory disorders of vagina', category: 'Gynaecological', synonyms: 'leucorrhoea white discharge' },
  { code: 'N73.9', display: 'Female pelvic inflammatory disease, unspecified', category: 'Gynaecological', synonyms: 'pid pelvic infection' },
  { code: 'N80.9', display: 'Endometriosis, unspecified', category: 'Gynaecological', chronic: true, synonyms: 'endometriosis' },
  { code: 'D25.9', display: 'Leiomyoma of uterus, unspecified', category: 'Gynaecological', chronic: true, synonyms: 'fibroid uterine fibroid myoma' },
  { code: 'N64.4', display: 'Mastodynia', category: 'Gynaecological', synonyms: 'breast pain mastalgia' },
  { code: 'N61', display: 'Inflammatory disorders of breast', category: 'Gynaecological', synonyms: 'mastitis breast abscess' },
  { code: 'N97.9', display: 'Female infertility, unspecified', category: 'Gynaecological', synonyms: 'infertility' },
  { code: 'Z30.9', display: 'Contraceptive management, unspecified', category: 'Encounters', synonyms: 'contraception family planning' },

  /* --- Musculoskeletal ---------------------------------------------------- */
  { code: 'M54.5', display: 'Low back pain', category: 'Musculoskeletal', synonyms: 'lbp backache back pain lumbago' },
  { code: 'M54.2', display: 'Cervicalgia', category: 'Musculoskeletal', synonyms: 'neck pain cervical pain' },
  { code: 'M54.9', display: 'Dorsalgia, unspecified', category: 'Musculoskeletal', synonyms: 'back pain spine pain' },
  { code: 'M54.3', display: 'Sciatica', category: 'Musculoskeletal', synonyms: 'sciatica radiculopathy leg pain' },
  { code: 'M51.2', display: 'Other specified intervertebral disc displacement', category: 'Musculoskeletal', synonyms: 'disc prolapse pivd slipped disc' },
  { code: 'M47.9', display: 'Spondylosis, unspecified', category: 'Musculoskeletal', chronic: true, synonyms: 'spondylosis cervical spondylosis' },
  { code: 'M25.5', display: 'Pain in joint', category: 'Musculoskeletal', synonyms: 'joint pain arthralgia' },
  { code: 'M17.9', display: 'Gonarthrosis, unspecified', category: 'Musculoskeletal', chronic: true, synonyms: 'knee osteoarthritis oa knee' },
  { code: 'M16.9', display: 'Coxarthrosis, unspecified', category: 'Musculoskeletal', chronic: true, synonyms: 'hip osteoarthritis' },
  { code: 'M15.9', display: 'Polyarthrosis, unspecified', category: 'Musculoskeletal', chronic: true, synonyms: 'osteoarthritis generalised oa' },
  { code: 'M06.9', display: 'Rheumatoid arthritis, unspecified', category: 'Musculoskeletal', chronic: true, synonyms: 'ra rheumatoid' },
  { code: 'M10.9', display: 'Gout, unspecified', category: 'Musculoskeletal', chronic: true, synonyms: 'gout uric acid' },
  { code: 'M79.1', display: 'Myalgia', category: 'Musculoskeletal', synonyms: 'muscle pain body ache myalgia' },
  { code: 'M79.7', display: 'Fibromyalgia', category: 'Musculoskeletal', chronic: true, synonyms: 'fibromyalgia' },
  { code: 'M75.0', display: 'Adhesive capsulitis of shoulder', category: 'Musculoskeletal', synonyms: 'frozen shoulder' },
  { code: 'M77.1', display: 'Lateral epicondylitis', category: 'Musculoskeletal', synonyms: 'tennis elbow' },
  { code: 'M77.0', display: 'Medial epicondylitis', category: 'Musculoskeletal', synonyms: 'golfer elbow' },
  { code: 'M72.2', display: 'Plantar fascial fibromatosis', category: 'Musculoskeletal', synonyms: 'plantar fasciitis heel pain' },
  { code: 'M65.9', display: 'Synovitis and tenosynovitis, unspecified', category: 'Musculoskeletal', synonyms: 'tenosynovitis' },
  { code: 'M81.9', display: 'Osteoporosis, unspecified', category: 'Musculoskeletal', chronic: true, synonyms: 'osteoporosis bone loss' },
  { code: 'M62.6', display: 'Muscle strain', category: 'Musculoskeletal', synonyms: 'muscle strain sprain' },
  { code: 'M70.9', display: 'Soft tissue disorder related to use, overuse and pressure', category: 'Musculoskeletal' },

  /* --- Neurological and psychiatric -------------------------------------- */
  { code: 'G43.9', display: 'Migraine, unspecified', category: 'Neurological', chronic: true, synonyms: 'migraine' },
  { code: 'G44.2', display: 'Tension-type headache', category: 'Neurological', synonyms: 'tension headache' },
  { code: 'G40.9', display: 'Epilepsy, unspecified', category: 'Neurological', chronic: true, synonyms: 'epilepsy seizures fits convulsions' },
  { code: 'R56.8', display: 'Other and unspecified convulsions', category: 'Neurological', synonyms: 'seizure convulsion fit' },
  { code: 'G62.9', display: 'Polyneuropathy, unspecified', category: 'Neurological', chronic: true, synonyms: 'neuropathy tingling numbness' },
  { code: 'G56.0', display: 'Carpal tunnel syndrome', category: 'Neurological', synonyms: 'carpal tunnel' },
  { code: 'G51.0', display: "Bell's palsy", category: 'Neurological', synonyms: 'bells palsy facial palsy' },
  { code: 'G20', display: "Parkinson's disease", category: 'Neurological', chronic: true, synonyms: 'parkinson parkinsonism' },
  { code: 'G47.0', display: 'Insomnia', category: 'Neurological', synonyms: 'insomnia sleeplessness cannot sleep' },
  { code: 'G47.3', display: 'Sleep apnoea', category: 'Neurological', chronic: true, synonyms: 'sleep apnoea osa snoring' },
  { code: 'G35', display: 'Multiple sclerosis', category: 'Neurological', chronic: true, synonyms: 'ms multiple sclerosis' },
  { code: 'F41.9', display: 'Anxiety disorder, unspecified', category: 'Psychiatric', chronic: true, synonyms: 'anxiety' },
  { code: 'F41.1', display: 'Generalised anxiety disorder', category: 'Psychiatric', chronic: true, synonyms: 'gad generalised anxiety' },
  { code: 'F41.0', display: 'Panic disorder', category: 'Psychiatric', chronic: true, synonyms: 'panic attacks' },
  { code: 'F32.9', display: 'Depressive episode, unspecified', category: 'Psychiatric', synonyms: 'depression low mood' },
  { code: 'F33.9', display: 'Recurrent depressive disorder, unspecified', category: 'Psychiatric', chronic: true },
  { code: 'F41.2', display: 'Mixed anxiety and depressive disorder', category: 'Psychiatric', chronic: true },
  { code: 'F43.2', display: 'Adjustment disorder', category: 'Psychiatric', synonyms: 'adjustment reaction stress' },
  { code: 'F45.9', display: 'Somatoform disorder, unspecified', category: 'Psychiatric', chronic: true },
  { code: 'F10.2', display: 'Alcohol dependence syndrome', category: 'Psychiatric', chronic: true, synonyms: 'alcohol dependence alcoholism' },
  { code: 'F17.2', display: 'Nicotine dependence', category: 'Psychiatric', chronic: true, synonyms: 'smoking tobacco nicotine' },
  { code: 'F20.9', display: 'Schizophrenia, unspecified', category: 'Psychiatric', chronic: true },
  { code: 'F31.9', display: 'Bipolar affective disorder, unspecified', category: 'Psychiatric', chronic: true, synonyms: 'bipolar' },
  { code: 'F90.9', display: 'Hyperkinetic disorder, unspecified', category: 'Psychiatric', chronic: true, synonyms: 'adhd hyperactivity' },
  { code: 'F84.0', display: 'Childhood autism', category: 'Psychiatric', chronic: true, synonyms: 'autism asd' },
  { code: 'F79', display: 'Unspecified mental retardation', category: 'Psychiatric', chronic: true, synonyms: 'intellectual disability developmental delay' },

  /* --- Skin --------------------------------------------------------------- */
  { code: 'L30.9', display: 'Dermatitis, unspecified', category: 'Skin', synonyms: 'dermatitis eczema rash' },
  { code: 'L20.9', display: 'Atopic dermatitis, unspecified', category: 'Skin', chronic: true, synonyms: 'atopic eczema' },
  { code: 'L23.9', display: 'Allergic contact dermatitis, unspecified cause', category: 'Skin', synonyms: 'contact dermatitis allergy rash' },
  { code: 'L29.9', display: 'Pruritus, unspecified', category: 'Skin', synonyms: 'itching pruritus itch' },
  { code: 'L50.9', display: 'Urticaria, unspecified', category: 'Skin', synonyms: 'urticaria hives wheals' },
  { code: 'L01.0', display: 'Impetigo', category: 'Skin', synonyms: 'impetigo' },
  { code: 'L02.9', display: 'Cutaneous abscess, furuncle and carbuncle, unspecified', category: 'Skin', synonyms: 'boil abscess furuncle' },
  { code: 'L03.9', display: 'Cellulitis, unspecified', category: 'Skin', synonyms: 'cellulitis' },
  { code: 'L08.9', display: 'Local infection of skin and subcutaneous tissue, unspecified', category: 'Skin', synonyms: 'skin infection pyoderma' },
  { code: 'B35.9', display: 'Dermatophytosis, unspecified', category: 'Skin', synonyms: 'fungal infection tinea ringworm' },
  { code: 'B35.4', display: 'Tinea corporis', category: 'Skin', synonyms: 'body ringworm' },
  { code: 'B35.6', display: 'Tinea cruris', category: 'Skin', synonyms: 'jock itch groin fungal' },
  { code: 'B35.3', display: 'Tinea pedis', category: 'Skin', synonyms: 'athlete foot' },
  { code: 'B36.0', display: 'Pityriasis versicolor', category: 'Skin', synonyms: 'tinea versicolor white patches' },
  { code: 'B37.9', display: 'Candidiasis, unspecified', category: 'Skin', synonyms: 'candida thrush fungal' },
  { code: 'B86', display: 'Scabies', category: 'Skin', synonyms: 'scabies itch mites' },
  { code: 'B85.0', display: 'Pediculosis due to Pediculus humanus capitis', category: 'Skin', synonyms: 'head lice' },
  { code: 'L70.0', display: 'Acne vulgaris', category: 'Skin', synonyms: 'acne pimples' },
  { code: 'L40.9', display: 'Psoriasis, unspecified', category: 'Skin', chronic: true, synonyms: 'psoriasis' },
  { code: 'L43.9', display: 'Lichen planus, unspecified', category: 'Skin', chronic: true },
  { code: 'L80', display: 'Vitiligo', category: 'Skin', chronic: true, synonyms: 'vitiligo white patches leucoderma' },
  { code: 'L81.4', display: 'Other melanin hyperpigmentation', category: 'Skin', synonyms: 'melasma pigmentation dark patches' },
  { code: 'L65.9', display: 'Nonscarring hair loss, unspecified', category: 'Skin', synonyms: 'hair fall hair loss alopecia' },
  { code: 'L60.0', display: 'Ingrowing nail', category: 'Skin', synonyms: 'ingrown nail' },
  { code: 'L21.9', display: 'Seborrhoeic dermatitis, unspecified', category: 'Skin', synonyms: 'dandruff seborrhoea' },
  { code: 'L82', display: 'Seborrhoeic keratosis', category: 'Skin' },
  { code: 'L72.1', display: 'Trichilemmal cyst', category: 'Skin', synonyms: 'sebaceous cyst' },
  { code: 'L98.9', display: 'Disorder of skin and subcutaneous tissue, unspecified', category: 'Skin' },

  /* --- Eye ---------------------------------------------------------------- */
  { code: 'H10.9', display: 'Conjunctivitis, unspecified', category: 'Eye', synonyms: 'conjunctivitis red eye pink eye' },
  { code: 'H00.0', display: 'Hordeolum and other deep inflammation of eyelid', category: 'Eye', synonyms: 'stye hordeolum' },
  { code: 'H01.0', display: 'Blepharitis', category: 'Eye', synonyms: 'blepharitis' },
  { code: 'H11.0', display: 'Pterygium', category: 'Eye', synonyms: 'pterygium' },
  { code: 'H25.9', display: 'Senile cataract, unspecified', category: 'Eye', chronic: true, synonyms: 'cataract' },
  { code: 'H40.9', display: 'Glaucoma, unspecified', category: 'Eye', chronic: true, synonyms: 'glaucoma raised eye pressure' },
  { code: 'H52.1', display: 'Myopia', category: 'Eye', synonyms: 'myopia short sight nearsighted' },
  { code: 'H52.0', display: 'Hypermetropia', category: 'Eye', synonyms: 'hypermetropia long sight farsighted' },
  { code: 'H52.2', display: 'Astigmatism', category: 'Eye', synonyms: 'astigmatism' },
  { code: 'H52.4', display: 'Presbyopia', category: 'Eye', synonyms: 'presbyopia reading glasses' },
  { code: 'H04.9', display: 'Disorder of lacrimal system, unspecified', category: 'Eye', synonyms: 'watering eye epiphora' },
  { code: 'H57.1', display: 'Ocular pain', category: 'Eye', synonyms: 'eye pain' },
  { code: 'H53.9', display: 'Visual disturbance, unspecified', category: 'Eye', synonyms: 'blurred vision vision problem' },
  { code: 'H16.9', display: 'Keratitis, unspecified', category: 'Eye', synonyms: 'keratitis corneal' },
  { code: 'H66.9', display: 'Otitis media, unspecified', category: 'Ear', synonyms: 'ear infection otitis media' },

  /* --- Ear, nose and throat ---------------------------------------------- */
  { code: 'H65.9', display: 'Nonsuppurative otitis media, unspecified', category: 'Ear', synonyms: 'serous otitis glue ear' },
  { code: 'H60.9', display: 'Otitis externa, unspecified', category: 'Ear', synonyms: 'ear canal infection otitis externa' },
  { code: 'H61.2', display: 'Impacted cerumen', category: 'Ear', synonyms: 'ear wax cerumen' },
  { code: 'H92.0', display: 'Otalgia', category: 'Ear', synonyms: 'ear pain earache' },
  { code: 'H93.1', display: 'Tinnitus', category: 'Ear', synonyms: 'tinnitus ringing in ears' },
  { code: 'H90.3', display: 'Sensorineural hearing loss, bilateral', category: 'Ear', chronic: true, synonyms: 'hearing loss deafness' },
  { code: 'H81.1', display: 'Benign paroxysmal vertigo', category: 'Ear', synonyms: 'bppv vertigo' },
  { code: 'H81.0', display: "Ménière's disease", category: 'Ear', chronic: true, synonyms: 'meniere vertigo' },
  { code: 'H81.3', display: 'Other peripheral vertigo', category: 'Ear', synonyms: 'vertigo' },
  { code: 'J34.2', display: 'Deviated nasal septum', category: 'Respiratory', synonyms: 'dns deviated septum' },
  { code: 'J33.9', display: 'Nasal polyp, unspecified', category: 'Respiratory', synonyms: 'nasal polyp' },

  /* --- Allergy and injury ------------------------------------------------ */
  { code: 'T78.4', display: 'Allergy, unspecified', category: 'Allergy', synonyms: 'allergy allergic reaction' },
  { code: 'T78.2', display: 'Anaphylactic shock, unspecified', category: 'Allergy', synonyms: 'anaphylaxis' },
  { code: 'T78.3', display: 'Angioneurotic oedema', category: 'Allergy', synonyms: 'angioedema swelling lips' },
  { code: 'T88.7', display: 'Unspecified adverse effect of drug or medicament', category: 'Allergy', synonyms: 'drug reaction adverse drug' },
  { code: 'T14.0', display: 'Superficial injury of unspecified body region', category: 'Injury', synonyms: 'abrasion graze bruise' },
  { code: 'T14.1', display: 'Open wound of unspecified body region', category: 'Injury', synonyms: 'cut laceration wound' },
  { code: 'T14.3', display: 'Dislocation, sprain and strain of unspecified body region', category: 'Injury', synonyms: 'sprain twist' },
  { code: 'T14.2', display: 'Fracture of unspecified body region', category: 'Injury', synonyms: 'fracture broken bone' },
  { code: 'T30.0', display: 'Burn of unspecified body region, unspecified degree', category: 'Injury', synonyms: 'burn scald' },
  { code: 'T63.4', display: 'Toxic effect of venom of other arthropods', category: 'Injury', synonyms: 'insect bite sting bee wasp' },
  { code: 'T63.0', display: 'Toxic effect of snake venom', category: 'Injury', synonyms: 'snake bite' },
  { code: 'T67.0', display: 'Heatstroke and sunstroke', category: 'Injury', synonyms: 'heat stroke sunstroke' },

  /* --- Encounters without a disease -------------------------------------- */
  { code: 'Z00.0', display: 'General medical examination', category: 'Encounters', synonyms: 'health checkup routine examination master health' },
  { code: 'Z02.0', display: 'Examination for admission to educational institution', category: 'Encounters', synonyms: 'school certificate fitness' },
  { code: 'Z02.1', display: 'Pre-employment examination', category: 'Encounters', synonyms: 'employment fitness certificate' },
  { code: 'Z13.9', display: 'Special screening examination, unspecified', category: 'Encounters', synonyms: 'screening' },
  { code: 'Z71.3', display: 'Dietary counselling and surveillance', category: 'Encounters', synonyms: 'diet advice nutrition counselling' },
  { code: 'Z76.0', display: 'Issue of repeat prescription', category: 'Encounters', synonyms: 'repeat prescription refill medicine continuation' },
  { code: 'Z09.9', display: 'Follow-up examination after unspecified treatment', category: 'Encounters', synonyms: 'follow up review' },
  { code: 'Z71.9', display: 'Counselling, unspecified', category: 'Encounters', synonyms: 'counselling advice' },
];
