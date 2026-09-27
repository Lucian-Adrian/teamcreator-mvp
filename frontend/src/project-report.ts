import type { ProjectRecord, ProjectWorkspace } from '../../shared/types';
import type { SimulationOutput } from '../../shared/simulation';

type ReportAudience = 'client' | 'sponsor';

const completedStatuses = new Set([
  'complete', 'completed', 'done', 'finished', 'finalized', 'accepted',
  'finalizat', 'finalizata', 'terminat', 'terminata', 'incheiat', 'incheiata', 'livrat', 'livrata', 'delivered',
]);
const approvalPattern = /approv(?:e|al|ed|ing)?|accept(?:ance|ed)?|aproba(?:re|rea|t|ta|te)?|acceptare|decizie|decision|authorization|autorizare/i;
const clientPattern = /client(?:ului|ului|ului|ă|ul|a)?|beneficiar(?:ului|ă|ul|a)?|beneficiary/i;

/** Builds a concise audience-specific report. Project facts are limited to PM-reviewed records. */
export function buildProjectReport(output: SimulationOutput | null, workspace: ProjectWorkspace, audience: ReportAudience): string {
  return audience === 'client'
    ? buildClientReport(output, workspace)
    : buildSponsorReport(output, workspace);
}

function buildClientReport(_output: SimulationOutput | null, workspace: ProjectWorkspace): string {
  const reviewed = [...workspace.tasks, ...workspace.deliverables].filter(isPmReviewed);
  const clientFacing = reviewed.filter((record) => record.kind === 'deliverable' || mentionsClient(record, workspace));
  const delivered = clientFacing.filter(isCompletedRecord);
  const upcoming = clientFacing.filter((record) => !isCompletedRecord(record));
  const decisions = clientDecisionNeeds(workspace);
  const lines = [
    `# Actualizare pentru client: ${clean(workspace.project.name)}`,
    '',
    '## Livrat și confirmat',
    ...(delivered.length
      ? delivered.map((record) => `- **${clean(record.title)}**${record.completed_at ? ` · finalizat la ${dateLabel(record.completed_at)}` : ''}. ${recordCitation(record, workspace)}`)
      : ['Necunoscut: nu există livrabile sau angajamente orientate către client, cu finalizare confirmată de PM.']),
    '',
    '## Angajamente și livrabile următoare',
    ...(upcoming.length
      ? upcoming.map((record) => {
          const date = record.due ? `termen consemnat ${dateLabel(record.due)}`
            : record.current_forecast ? `prognoză curentă ${dateLabel(record.current_forecast)}`
              : record.baseline_due ? `dată de referință ${dateLabel(record.baseline_due)}`
                : 'dată necunoscută';
          return `- **${clean(record.title)}** · ${date}. ${recordCitation(record, workspace)}`;
        })
      : ['Necunoscut: nu există angajamente sau livrabile următoare confirmate de PM.']),
    '',
    '## Decizie necesară de la client',
    ...decisions,
    '',
    'Ciornă pentru verificarea PM-ului înainte de trimitere.',
  ];
  return lines.join('\n');
}

function buildSponsorReport(output: SimulationOutput | null, workspace: ProjectWorkspace): string {
  if (!output) return [
    `# Raport pentru conducere: ${clean(workspace.project.name)}`,
    '',
    '## Obiectiv',
    'Necunoscut: nu există un câmp de obiectiv confirmat și citat în registrul proiectului.',
    '',
    '## Abatere față de plan',
    'Necalculabilă: nu este disponibilă o distribuție simulată și nu există un baseline comparabil în rezultat.',
    '',
    '## Capacitate și opțiuni',
    'Necunoscut: rulează simularea după verificarea estimărilor și capacităților pentru a calcula indicatori și comparații.',
    'Nicio intervenție nu a fost comparată; efectul opțiunilor este necunoscut.',
    '',
    '## Decizie de conducere',
    '**Sugestie, neconfirmată:** confirmă obiectivul și baseline-ul comparabil, apoi alege dacă merită testată o intervenție. Decidentul nu este numit în surse confirmate.',
    '',
    'Ciornă pentru verificarea PM-ului înainte de trimitere.',
  ].join('\n');
  const baseline = output.kind === 'simulation_comparison' ? output.baseline : output;
  const scenario = output.kind === 'simulation_comparison' ? output.scenario : output;
  const paired = output.kind === 'simulation_comparison';
  const modelCitation = `Rezultat calculat · v${scenario.modelVersion} · seed ${scenario.seed} · ${scenario.iterations.toLocaleString('ro-RO')} rulări · config ${scenario.configFingerprint.slice(0, 12)}`;
  const optionLines = paired
    ? [
        `- **Baza curentă:** P50 ${days(baseline.completionDays.p50)}, P90 ${days(baseline.completionDays.p90)}. Inferență din simulare.`,
        `- **Intervenție testată:** ${clean(output.intervention.label)} · P50 ${days(scenario.completionDays.p50)}, P90 ${days(scenario.completionDays.p90)} · diferență P50 ${signedDays(output.completionDeltaDays.p50)} · șansă simulată de finalizare mai rapidă ${(output.probabilityOfFasterFinish * 100).toLocaleString('ro-RO', { maximumFractionDigits: 1 })}%. Inferență din perechea cu aceleași extrageri aleatoare.`,
      ]
    : [
        `- **Baza curentă:** P50 ${days(scenario.completionDays.p50)}, P90 ${days(scenario.completionDays.p90)}. Inferență din simulare.`,
        '- **Alternativă:** niciun scenariu de intervenție nu a fost comparat. Efectul unei schimbări este necunoscut.',
        '- **Sugestie, neconfirmată:** alegeți o intervenție pentru o comparație pereche înainte de a o trata ca opțiune cu efect estimat.',
      ];
  const capacity = scenario.metrics;
  const missing = scenario.missingness;
  const lines = [
    `# Raport pentru conducere: ${clean(workspace.project.name)}`,
    '',
    `Rulare: ${scenario.generatedAt} · model ${scenario.modelVersion} · seed ${scenario.seed} · ${scenario.iterations.toLocaleString('ro-RO')} iterații.`,
    '',
    '## Obiectiv',
    'Necunoscut: registrul proiectului nu conține un câmp de obiectiv confirmat și citat.',
    '',
    '## Abatere față de plan',
    'Necalculabilă: intervalul simulat este în zile lucrătoare de la începutul modelului, iar un baseline aprobat și comparabil nu este disponibil în rezultatul simulării.',
    '',
    '## Capacitate și acoperirea intrărilor',
    `- Sarcini active modelate: ${capacity.activeTaskCount}. Acoperire de alocare: ${(capacity.assignmentCoverage * 100).toLocaleString('ro-RO', { maximumFractionDigits: 1 })}%. Coada de capacitate P50: ${days(capacity.capacityQueueDays.p50)}. ${modelCitation}`,
    `- Estimări de durată neconfirmate: ${missing.placeholderEstimateTaskIds.length}; capacități neconfirmate: ${missing.placeholderCapacityMemberIds.length}; sarcini fără alocare: ${missing.unassignedTaskIds.length}; dependențe nerezolvate: ${missing.unresolvedDependencyTaskIds.length}. Acestea descriu lipsurile modelului, nu constatări despre performanța echipei. ${modelCitation}`,
    '',
    '## Opțiuni modelate',
    ...optionLines,
    ...(scenario.deadlineOutlook ? [
      '',
      `Încadrare la termenul ${scenario.deadlineOutlook.deadlineDate}: ${scenario.deadlineOutlook.onTime.count.toLocaleString('ro-RO')} la termen, ${scenario.deadlineOutlook.lateUpTo7Days.count.toLocaleString('ro-RO')} cu până la 7 zile întârziere, ${scenario.deadlineOutlook.lateMoreThan7Days.count.toLocaleString('ro-RO')} peste 7 zile. Rezultat calculat din ${scenario.deadlineOutlook.sampleCount.toLocaleString('ro-RO')} rulări.`,
    ] : ['Termen țintă și distribuție pe categorii: necunoscute; nu a fost configurat un termen.']),
    '',
    '## Decizie de conducere',
    `**Sugestie, neconfirmată:** confirmați obiectivul și un baseline comparabil; apoi decideți dacă păstrați ipotezele curente sau testați o intervenție${paired ? ` precum „${clean(output.intervention.label)}”` : ''}. Niciun rol sau decident nu este atribuit aici fără o înregistrare confirmată de PM. ${modelCitation}`,
    '',
    'Valorile simulate sunt inferențe condiționate de estimările și capacitățile configurate; ele nu sunt date promise sau cauzalitate.',
  ];
  return lines.join('\n');
}

function clientDecisionNeeds(workspace: ProjectWorkspace): string[] {
  const reviewedDecisions = workspace.decisions.filter(isPmReviewed);
  const explicit = reviewedDecisions.filter((record) => isApprovalSignal(record) && isClientFacingApproval(record, workspace));
  if (explicit.length) return explicit.map((record) => `- **Înregistrare confirmată de PM:** ${clean(record.title)}. Decidentul clientului rămâne necunoscut dacă nu este numit explicit. ${recordCitation(record, workspace)}`);

  const suggestedEvidence = [...workspace.tasks, ...workspace.deliverables]
    .filter(isPmReviewed)
    .filter((record) => isApprovalSignal(record) && mentionsClient(record, workspace));
  if (suggestedEvidence.length) {
    const citations = unique(suggestedEvidence.flatMap((record) => recordCitationParts(record, workspace)));
    return [
      '- **Sugestie, neconfirmată:** confirmați dacă este necesară o aprobare din partea clientului sau beneficiarului. Nu există o decizie client confirmată și niciun decident numit.',
      `  Fundament: înregistrările revizuite de PM conțin limbaj despre aprobare pentru client/beneficiar. ${citations.length ? citations.join('; ') : 'Sursa atașată: necunoscută.'}`,
    ];
  }
  return ['Necunoscut: nicio decizie PM-confirmată și nicio sursă legată de înregistrare nu identifică explicit o aprobare cerută de client sau beneficiar.'];
}

function isClientFacingApproval(record: ProjectRecord, workspace: ProjectWorkspace): boolean {
  return mentionsClient(record, workspace);
}

function isApprovalSignal(record: ProjectRecord): boolean {
  return approvalPattern.test([record.title, record.description || '', ...(record.source_refs || []).map((ref) => ref.quote)].join(' '));
}

function mentionsClient(record: ProjectRecord, workspace: ProjectWorkspace): boolean {
  const directEvidence = [record.title, record.description || '', ...(record.source_refs || []).map((ref) => ref.quote)].some((text) => clientPattern.test(text));
  if (directEvidence) return true;
  const owner = workspace.members.find((member) =>
    (record.owner_id && member.id === record.owner_id) || (record.owner && member.title === record.owner));
  return Boolean(owner && isPmReviewed(owner) && clientPattern.test(owner.role || '') && owner.field_refs?.role?.length);
}

function isPmReviewed(record: ProjectRecord): boolean {
  return record.review_state === 'manager_confirmed' || record.review_state === 'manager_corrected';
}

function isCompletedRecord(record: ProjectRecord): boolean {
  const status = normalizeStatus(record.status);
  if (status) return completedStatuses.has(status);
  return Boolean(record.completed_at);
}

function normalizeStatus(status: string | null): string {
  return (status || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function recordCitation(record: ProjectRecord, workspace: ProjectWorkspace): string {
  const citations = recordCitationParts(record, workspace);
  return citations.length ? `Sursă: ${citations.join('; ')}.` : 'Sursă necunoscută; înregistrarea este totuși revizuită de PM.';
}

function recordCitationParts(record: ProjectRecord, workspace: ProjectWorkspace): string[] {
  const recordRefs = (record.source_refs || []).map((ref) => {
    const source = workspace.sources.find((item) => item.id === ref.source_id);
    const name = source?.relative_path || source?.name || ref.source_id;
    return `${name} · ${clean(ref.location)}`;
  });
  const owner = workspace.members.find((member) =>
    (record.owner_id && member.id === record.owner_id) || (record.owner && member.title === record.owner));
  const roleRefs = owner && isPmReviewed(owner) && clientPattern.test(owner.role || '')
    ? (owner.field_refs?.role || []).flatMap((ref) => {
        const source = workspace.sources.find((item) => item.id === ref.source_id);
        return [`${source?.relative_path || source?.name || ref.source_id} · ${clean(ref.location)}`];
      })
    : [];
  return unique([...recordRefs, ...roleRefs]);
}

function unique(values: string[]): string[] { return [...new Set(values)]; }
function clean(value: string): string { return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim(); }
function dateLabel(value: string): string { return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : clean(value); }
function days(value: number): string { return `${value.toLocaleString('ro-RO', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} zile lucrătoare`; }
function signedDays(value: number): string { return `${value > 0 ? '+' : ''}${value.toLocaleString('ro-RO', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} zile`; }
