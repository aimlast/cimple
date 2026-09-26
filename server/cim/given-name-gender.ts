/**
 * given-name-gender — first names that almost always belong to one gender,
 * for the CIM's pronoun check (prose-check guessedGender).
 *
 * The check exists because the writer guessed a gender from a name and got
 * it wrong ("Manpreet … she" — Manpreet is Harjit's son; Punjabi given names
 * are mostly used for both). Flagging every he/she for anyone the file gives
 * no gender (Helen, Aisha, Kyle, Liam…) buried that one real problem in a
 * dozen false alarms, each costing a section rewrite. So a pronoun that
 * matches a strongly gendered common first name is accepted; names used for
 * both (Manpreet, Dana, Jordan, Morgan, Dale, Rajvir…) and names not listed
 * still need the file to say.
 *
 * Deliberately conservative: a name belongs here only when it is used for one
 * gender in the overwhelming majority of cases in Canada and the US, and is
 * not also an everyday word (Bill, Grant, Mark, June and Rose are left out).
 */

const MALE = `aaron adam adrian ahmed alan albert alejandro alex alexander ali amir andre andrew angelo anthony antonio arjun arnold arthur arun ashok barry ben benjamin bernard billy bob bobby brad bradley brandon brendan brent brett brian brien bruce bryan calvin carl carlos chad charles chris christopher clarence clifford colin connor craig curtis dan daniel darren dave david dennis derek devin diego dimitri dmitri don donald doug douglas duncan dustin dwayne dylan earl eddie edgar edward eli elijah eric erik ethan eugene evan fred frederick gabriel gary gavin geoffrey george gerald glen glenn gordon graham greg gregory hamid harold harry hassan hector henry howard hugh ian isaac ivan jack jacob jake james jared jason javier jay jeff jeffrey jeremy jerry jesse jim jimmy joe joel john johnny jon jonathan jorge jose joseph josh joshua juan justin karl keith ken kenneth kevin kieran kirk kyle larry lawrence leonard liam logan lorenzo louis lucas luis luke malcolm marc marco marcus mario martin marvin matt matthew michael miguel mike mitchell mohammed muhammad nathan neil nicholas nick nigel noah norman oliver omar oscar owen patrick paul paulo pedro peter philip phillip pierre rahul raj rajesh ralph ramon randy ravi raymond ricardo richard rick ricky rob robert roberto rodney roger rohan roland ron ronald ross roy russell ryan salvatore sam samuel scott sean sergio seth shane shaun shawn simon stanley stefan stephen steve steven stuart suresh ted terry thomas tim timothy todd tom tommy tony travis trevor troy tyler victor vijay vincent walter warren wayne william zachary`;

const FEMALE = `abigail agnes aisha alexandra alice alicia alison allison amanda amelia amy ana andrea angela angelica anita ann anna anne annette ashley audrey barbara beatrice becky belinda beth bethany betty beverly bonnie brenda brianna brittany brooke camila carla carmen carol caroline carolyn catherine cathy charlene charlotte chelsea cheryl chloe christina christine cindy claire clara claudia colleen cynthia danielle darlene deborah debra denise diana diane dolores donna doris dorothy edith eileen elaine eleanor elena elizabeth ella ellen emily emma erica erin esther eva evelyn farah fatima fiona florence frances gabriela gail gina gloria grace gwen hannah heather heidi helen irene isabel isabella jacqueline jane janet janice jasmine jean jeanette jennifer jenny jessica jill joan joanne josephine joyce judith judy julia julie karen kate katherine kathleen kathryn kathy katie kayla kelly kimberly kristen kristin laura lauren leah lillian linda lindsay lisa lois lori lorraine louise lucy lydia lynn madison mandy margaret maria marie marilyn marion marjorie martha mary megan mei-lin melanie melissa mia michelle mildred mira miranda molly monica nadia nancy natalie natasha nicole nina norma olivia paige pamela patricia paula pauline peggy phyllis priya priyanka rachel rebecca regina renee rhonda rita roberta rosa ruth sabrina samantha sandra sara sarah sharon sheila shelley shirley sofia sonia sophia sophie stacy stephanie sue susan suzanne sylvia tamara tammy tanya teresa theresa tiffany tina tracy valerie vanessa veronica victoria virginia vivian wanda wendy yolanda yvonne zoe`;

const TABLE = new Map<string, "m" | "f">();
for (const n of MALE.split(/\s+/)) if (n) TABLE.set(n, "m");
for (const n of FEMALE.split(/\s+/)) if (n) TABLE.set(n, "f");

/** "m" / "f" for a strongly gendered common first name, else null (unknown or used for both). */
export function genderOfGivenName(first: string): "m" | "f" | null {
  return TABLE.get(first.toLowerCase()) ?? null;
}
