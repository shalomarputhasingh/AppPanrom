import counter from '../../examples/counter.apn?raw';
import notes from '../../examples/notes.apn?raw';
import vanakkam from '../../examples/vanakkam.apn?raw';
import calculator from '../../examples/calculator.apn?raw';
import machan from '../../examples/machan.apn?raw';
import machanIcon from '../../examples/machan-icon.png?url';
import vaanilai from '../../examples/vaanilai.apn?raw';
import idam from '../../examples/idam.apn?raw';
import showcase from '../../examples/showcase.apn?raw';
import calculatorIcon from '../../examples/calculator-icon.png?url';

export interface Template { id: string; name: string; blurb: string; code: string | null; icon?: string }

/** Starting points offered when creating a project (code null = the backend's default sample). */
export const TEMPLATES: Template[] = [
  { id: 'default', name: 'Starter', blurb: 'A small working sample', code: null },
  { id: 'machan', name: 'Machan Planner (Tanglish)', blurb: 'Full app: tasks, expenses, dialogues, game, 5 looks, dark mode', code: machan, icon: machanIcon },
  { id: 'vaanilai', name: 'Vaanilai (web API)', blurb: 'Live weather with api_vaangu; Tanglish, clay look', code: vaanilai },
  { id: 'idam', name: 'Naan Enga (location + notification)', blurb: 'Asks permission at run time: location_edu, notification_kaattu', code: idam },
  { id: 'calculator', name: 'Calculator (Clay)', blurb: 'Colourful clay-style calculator with app icon', code: calculator, icon: calculatorIcon },
  { id: 'showcase', name: 'Style showcase', blurb: 'Glass, clay, brutal, minimal, soft UI + animations', code: showcase },
  { id: 'counter', name: 'Counter', blurb: 'State and a row layout', code: counter },
  { id: 'notes', name: 'Notes', blurb: 'Lists and local storage', code: notes },
  { id: 'vanakkam', name: 'Vanakkam', blurb: 'Inputs and two screens', code: vanakkam },
];
export const EXAMPLE_LIST = TEMPLATES.filter((t) => t.code).map((t) => ({ name: `${t.name} - ${t.blurb}`, code: t.code as string }));
