// Decision 347 (§4.2): the password rule for link redemption (invite /
// password reset), shared by the kernel (authoritative) and the dashboard's
// /join form (early feedback). `login`, `adminSetPassword` and
// `authChangePassword` keep their historical min-8 rule so existing accounts
// keep working.
//
// TWO lists, because a 12-character floor makes a plain top-1000 almost
// decorative: 982 of its 994 entries are shorter than 12 characters and can
// never be typed into this form.
//
//   LONG_COMMON_PASSWORDS — the first 1000 entries of at least 12 characters
//   from SecLists `Passwords/Common-Credentials/Pwdb_top-100000.txt`, kept in
//   the source's frequency order (1421 of its 100 000 entries survive
//   normalization at that length; the first 1000 are the ones anyone actually
//   reuses). These are matched
//   whole. NOTE: the review named
//   `10-million-password-list-top-100000.txt`, which no longer exists upstream;
//   `Pwdb_top-100000.txt` is the same family as the short list below, so both
//   lists share one provenance and one frequency ordering.
//
//   COMMON_PASSWORDS — SecLists `Pwdb_top-1000.txt` (994 entries after
//   lower-casing and de-duplication), matched against the password's STEM.
//   A person forced to reach twelve characters pads a familiar word:
//   `password1234`, `iloveyou2026!`, `qwertyuiop12`. Stripping the trailing
//   digits and punctuation exposes the word, and the short list is exactly the
//   catalogue of those words — which is why it stays complete instead of being
//   pruned to its long entries.
//
// Both files were fetched from the master branch and normalized by the same
// rule the check uses: trim, lower-case, de-duplicate, order preserved.

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export type PasswordPolicyVerdict = "ok" | "too_short" | "too_long" | "common";

/** SecLists Pwdb_top-1000, normalized. Matched against the stem, so the short
 * entries are the load-bearing ones. */
const COMMON_PASSWORD_LIST: readonly string[] = [
  "123456", "123456789", "password", "qwerty", "12345678", "12345", "123123", "111111", "1234",
  "1234567890", "1234567", "abc123", "1q2w3e4r5t", "q1w2e3r4t5y6", "iloveyou", "123", "000000",
  "123321", "1q2w3e4r", "qwertyuiop", "yuantuo2012", "654321", "qwerty123", "1qaz2wsx3edc",
  "password1", "1qaz2wsx", "666666", "dragon", "ashley", "princess", "987654321", "123qwe",
  "159753", "monkey", "q1w2e3r4", "zxcvbnm", "123123123", "asdfghjkl", "pokemon", "football",
  "killer", "112233", "michael", "shadow", "121212", "daniel", "asdasd", "qazwsx", "1234qwer",
  "superman", "123456a", "azerty", "qwe123", "master", "7777777", "sunshine", "n0=acc3ss",
  "1q2w3e", "abcd1234", "1234561", "computer", "fuckyou", "aaaaaa", "555555", "asdfgh", "asd123",
  "baseball", "0123456789", "charlie", "123654", "qwer1234", "naruto", "a123456", "jessica",
  "status", "soccer", "jordan", "liverpool", "thomas", "lol123", "michelle", "123abc", "nicole",
  "11111111", "starwars", "samsung", "1111", "secret", "joshua", "123456789a", "andrew",
  "222222", "q1w2e3r4t5", "147258369", "hunter", "qazwsxedc", "lovely", "999999", "jennifer",
  "letmein", "tigger", "asdf1234", "hannah", "purple", "justin", "qwerty1", "anthony", "welcome",
  "love", "159357", "789456123", "aa123456", "qweasdzxc", "internet", "robert", "minecraft",
  "super123", "batman", "trustno1", "matthew", "789456", "88888888", "5201314", "chocolate",
  "flower", "cookie", "d1lakiss", "william", "102030", "cheese", "buster", "pakistan", "chelsea",
  "alexander", "888888", "12341234", "987654", "andrea", "777777", "hello", "samantha",
  "1234567891", "blink182", "freedom", "matrix", "george", "amanda", "1qazxsw2", "forever",
  "martin", "patrick", "iloveu", "babygirl", "summer", "friends", "whatever", "12qwaszx",
  "pepper", "zaq12wsx", "212121", "butterfly", "0000", "orange", "jasmine", "joseph", "maggie",
  "banana", "arsenal", "mustang", "11111", "monster", "passw0rd", "jonathan", "snoopy",
  "0987654321", "family", "changeme", "131313", "123qweasd", "ginger", "angel", "junior",
  "diamond", "asdfasdf", "taylor", "eminem", "oliver", "exigent", "147258", "basketball",
  "sophie", "loveme", "mother", "benjamin", "silver", "333333", "101010", "harley", "spiderman",
  "chicken", "a123456789", "asshole", "123654789", "12345678910", "696969", "qweasd", "yellow",
  "melissa", "qwertyui", "christian", "nathan", "anhyeuem", "brandon", "richard", "nks230kjs82",
  "rr123456rr", "metallica", "never", "00000000", "123hfjdk147", "lovers", "mercedes",
  "123456abc", "gabriel", "password123", "loveyou", "mickey", "147852369", "1111111", "010203",
  "bailey", "hello123", "sandra", "london", "qwerty12", "zxcvbn", "q1w2e3", "slipknot",
  "741852963", "qwerty12345", "prince", "hockey", "55555", "angels", "peanut", "victoria",
  "12344321", "asdf", "angela", "rainbow", "abcdef", "ferrari", "google", "cocacola",
  "1111111111", "hahaha", "carlos", "gfhjkm", "qweqwe", "456789", "12345qwert", "jordan23",
  "11223344", "bubbles", "steven", "samuel", "rental", "xxxxxx", "00000", "0123456", "barbie",
  "morgan", "asdasdasd", "alexis", "elizabeth", "michael1", "austin", "nicholas", "school",
  "1q2w3e4r5t6y", "lollol", "barcelona", "pokemon1", "iloveyou1", "147852", "87654321", "diablo",
  "jasper", "liverpool1", "phoenix", "madison", "vanessa", "jackson", "123qweasdzxc", "danielle",
  "marina", "jesus", "xbox360", "pretty", "thunder", "bandit", "indya123", "a1b2c3d4", "232323",
  "adidas", "dennis", "edward", "ronaldo", "adrian", "rachel", "tennis", "destiny", "fuckoff",
  "startfinding", "friendster", "lauren", "qqqqqq", "456123", "<password>", "darkness",
  "nicolas", "nirvana", "mylove", "scooter", "fashion", "merlin", "qazwsx123", "sakura", "david",
  "charlie1", "vincent", "casper", "asdfghjk", "november", "juventus", "lizottes", "spider",
  "smokey", "1234abcd", "abcdefg", "december", "lalala", "spongebob", "booboo", "chester",
  "loulou", "heather", "qwert", "america", "yamaha", "princess1", "123789", "monica", "victor",
  "canada", "scorpion", "friend", "antonio", "sebastian", "nintendo", "awesome", "nikita",
  "rebecca", "sabrina", "bhf", "midnight", "sweety", "testing", "passwort", "852456",
  "azertyuiop", "hg0209", "groupd2013", "olivia", "johnny", "patricia", "warcraft", "stella",
  "comeon11", "guitar", "jeremy", "qwe", "playboy", "charles", "creative", "elephant",
  "football1", "r9lw4j8khx", "fucker", "caroline", "12345a", "123qwe123", "crystal", "louise",
  "success", "compaq", "cameron", "inuyasha", "maverick", "scooby", "alexandra", "james",
  "garfield", "apples", "123456aa", "gemini", "lovelove", "dolphin", "dakota", "september",
  "logitech", "a12345", "qwaszx", "hotmail", "444444", "qazxsw", "sasuke", "sparky", "hallo123",
  "magic", "test", "aaaaaaaa", "twilight", "tweety", "shannon", "myspace1", "beautiful",
  "stephanie", "asdasd123", "swordfish", "jessie", "tinkerbell", "2012comeer", "flowers",
  "0000000000", "doudou", "cooper", "charlotte", "dallas", "999999999", "hellokitty", "winner",
  "159951", "1a2b3c4d", "love123", "nothing", "abc123456", "test123", "111222", "badboy",
  "heaven", "qwert123", "windows", "hardcore", "qwertyu", "muffin", "252525", "tigers",
  "manchester", "yankees", "123456q", "jackie", "money", "popcorn", "cherry", "marseille", "111",
  "welcome1", "marlboro", "poohbear", "kitten", "fuckme", "newyork", "753951", "fuckyou1",
  "slayer", "qaz123", "sayang", "142536", "rabbit", "1234554321", "ranger", "barney", "icecream",
  "12121212", "veronica", "a1b2c3", "lol", "dexter", "melanie", "kimberly", "123456789q",
  "precious", "pass", "marvin", "lakers", "chris", "natasha", "lollipop", "scorpio", "p", "alex",
  "123451", "albert", "zzzzzz", "tiffany", "hello1", "peaches", "rangers", "murphy", "carolina",
  "soleil", "india123", "august", "54321", "christine", "disney", "jessica1", "greenday",
  "portugal", "hacker", "bonnie", "brandy", "newpass", "951753", "9876543210", "camille",
  "winter", "qq123456", "boomer", "jesus1", "246810", "leonardo", "october", "superman1",
  "beauty", "124578", "1234567a", "daniela", "poopoo", "samson", "cristina", "music", "winston",
  "angelo", "741852", "123asd", "coffee", "manuel", "zxc123", "player", "bismillah",
  "4815162342", "aaaa", "honey", "a1234567", "fluffy", "parola", "alyssa", "claudia", "134679",
  "456456", "genius", "horses", "hiphop", "angel1", "jackass", "1212", "steelers", "asd123456",
  "monkey1", "arthur", "runescape", "matthew1", "qwerty123456", "golden", "happy", "simpsons",
  "denise", "red123", "tintin", "toyota", "vegeta", "963852741", "sydney", "isabella", "francis",
  "porsche", "1314520", "miguel", "sterling", "turtle", "pikachu", "arsenal1", "hottie",
  "blabla", "stupid", "hallo", "anthony1", "police", "chelsea1", "mar", "mahalkita", "softball",
  "snickers", "catherine", "trinity", "vampire", "cassie", "fantasy", "kenneth", "rockstar",
  "12345qwerty", "bonjour", "eagles", "snowball", "pumpkin", "corvette", "maxwell", "marine",
  "aaaaa", "jakjak", "wilson", "7654321", "willow", "pussy", "gateway", "motorola", "098765",
  "simple", "cookies", "dancer", "hammer", "12345678a", "1029384756", "maria", "connor",
  "fernando", "abc12345", "carmen", "natalie", "florida", "falcon", "polska", "remember",
  "woaini", "biteme", "sarah", "321321", "fender", "emmanuel", "simone", "qwertz", "brittany",
  "blahblah", "barbara", "alicia", "pookie", "qwerty1234", "knight", "sniper", "shopping",
  "isabelle", "parker", "freddy", "youbye123", "marcus", "please", "superstar", "computer1", "n",
  "hotdog", "cambiami", "pass123", "asdfg", "lucky", "sanane", "monika", "christ", "123698745",
  "fishing", "kawasaki", "6v21wbgad", "iceman", "cowboy", "kevin", "1122334455", "courtney",
  "pamela", "krishna", "julian", "tiger", "aobo2010", "21212121", "qqww1122", "password12",
  "penguin", "valentina", "miller", "010101", "fuckyou2", "brooklyn", "50cent", "warrior",
  "boston", "lolipop", "jerome", "qwerasdf", "shorty", "scarface", "pa55word", "people",
  "claire", "william1", "pogiako", "chicago", "456852", "1123581321", "johnson", "chris1",
  "ryan", "demon1q2w3e", "123123a", "wizard", "angelina", "williams", "stephen", "christopher",
  "7758521", "iloveyou2", "shelby", "bulldog", "undertaker", "fatima", "cowboys", "jasmin",
  "linkinpark", "drowssap", "teresa", "fuck", "sierra", "angelica", "tucker", "lolita", "online",
  "mexico", "demon1q2w3e4r", "007007", "sunshine1", "bullshit", "202020", "ghbdtn", "1464688081",
  "pierre", "blessed", "manutd", "012345", "cricket", "qazqaz", "asdqwe123", "winnie", "butter",
  "nonmember", "sweetie", "baseball1", "iloveme", "admin", "passion", "a1s2d3f4", "xavier",
  "dolphins", "paradise", "skyline", "redsox", "demon1q2w3e4r5t", "1a2b3c", "genesis", "mmmmmm",
  "135790", "poop", "lincogo1", "gandalf", "159753qq", "nascar", "chouchou", "apple",
  "zxcvbnm123", "password2", "ihateyou", "qwert12345", "stefan", "stargate", "12345q",
  "microsoft", "january", "chance", "christina", "jason", "dragonball", "gangster", "potter",
  "roberto", "killer123", "speedy", "black", "i", "spencer", "147896325", "alejandro", "martina",
  "santiago", "jeffrey", "teacher", "rosebud", "raymond", "nissan", "nelson", "qweasd123",
  "cupcake", "sophia", "nigger", "natalia", "kristina", "bananas", "legolas", "indian", "sexy",
  "jaguar", "calvin", "lorenzo", "access", "strawberry", "sunflower", "sharon", "bigdaddy",
  "blink123", "travis", "united", "bianca", "cme2012", "assassin", "telechargement",
  "1234512345", "baby", "champion", "justine", "avatar", "151515", "brandon1", "green",
  "abcdefgh", "mnbvcxz", "raiders", "1234560", "panther", "mamapapa", "donald", "starwars1",
  "asd", "harrypotter", "mike", "141414", "legend", "samsung1", "789789", "john", "zachary",
  "westside", "ssssss", "a12345678", "dragon1", "7777", "m", "kingkong", "facebook", "carter",
  "skater", "motdepasse", "gundam", "phantom", "bearshare", "doctor", "karina", "asdf123",
  "asdf12345", "montana", "loverboy", "alexandre", "celtic", "cool", "megaparol12345", "4444",
  "orlando", "bond007", "pokemon123", "minnie", "maryjane", "ragnarok", "millie", "savannah",
  "159159", "walter", "mahalko", "kissme", "damian", "anderson", "element", "peter", "hamster",
  "abigail", "animal", "jasmine1", "786786", "california", "system", "helpme", "apollo",
  "gracie", "ladybug", "australia", "qwer", "valentin", "pauline", "frankie", "cancer",
  "siemens", "realmadrid", "zxcvbnm1", "justinbieber", "kitty", "megaman", "admin123",
  "baili123com", "wow12345", "rush2112", "einstein", "marley", "321654", "5555", "100",
  "timothy", "startrek", "qwerty321", "unicorn", "audrey", "maganda", "golfcourse", "rafael",
  "2222", "france", "security", "tristan", "dreams", "harvey", "marie", "pk3x7w9w", "hitman",
  "ficken", "coucou", "8675309", "debbie", "1qa2ws3ed", "andreas", "freedom1", "hesoyam",
  "florian", "nyq28giz1z", "cheyenne", "celine", "florence", "0000000", "spirit", "test1234",
  "tamara", "maximus", "ricardo", "bitch", "lucky1", "copper", "jupiter", "marcel", "andrei",
  "chicken1", "domino", "oblivion", "crossfire", "bestfriend", "pantera", "brenda", "camaro",
  "buddy", "pass1234", "rocket", "g13916055158",
];

/** SecLists Pwdb_top-100000 filtered to >= PASSWORD_MIN_LENGTH characters,
 * first 1000 in frequency order. Matched whole. */
const LONG_COMMON_PASSWORD_LIST: readonly string[] = [
  "q1w2e3r4t5y6", "1qaz2wsx3edc", "1q2w3e4r5t6y", "123qweasdzxc", "startfinding", "qwerty123456",
  "demon1q2w3e4r", "demon1q2w3e4r5t", "telechargement", "megaparol12345", "justinbieber",
  "g13916055158", "lpz93ssskqw8q", "123456qwerty", "jundian2011xr", "qweasdzxc123",
  "yfdbufnjh10305070", "123456123456", "qazwsxedc123", "123456654321", "qazwsxedcrfv",
  "finalfantasy", "123456789123", "john!20130605at1753", "projectsadminx", "motherfucker",
  "1q2w3e4r5t6y7u", "falighthouse", "minecraft123", "123qwe123qwe", "playstation3",
  "onedirection", "qwertyqwerty", "dfg5fhg5vgfh1", "zxcasdqwe123", "123456789vuonggialong",
  "ichliebedich", "aida2013sale", "123456789asd", "password1234", "123456789abc",
  "qwertyuiop123", "sdf7asdf6asdg8df", "112233445566", "mypassphrase", "leavemealone",
  "qwerasdfzxcv", "1q2w3e4r5t6y7u8i", "123456789123456789", "1qazxsw23edc", "asdfghjkl123",
  "google123google", "123456789qwe", "nevertarget7", "jamesbond007", "playstation2",
  "hannahmontana", "ashishbiyani", "1q2w3e4r5t6y7u8i9o0p", "s9qxa9yn9cc=", "sonnenschein",
  "123admin321a", "transformers", "zmx870919123", "123456789987654321", "tempesth1941",
  "b9399f21060d4b5fcb6d3cf5fea8de", "123321123321", "needforspeed", "111111111111",
  "123123123123", "xtseo2011tdx", "qwe123qwe123", "abc123456789", "counterstrike",
  "professional", "liverpool123", "seniseviyoru", "international", "supernatural",
  "gv5235523532", "peanutbutter", "administrator", "sonyericsson", "kingdomhearts",
  "sojdlg123aljg", "6666666666empulgara", "010203040506", "doomsayer.2.7mords.v",
  "1qaz2wsx3edc4rfv", "seniseviyorum", "residentevil", "lydcc20091314", "dlinkers2011",
  "@gmail.com.mx", "*6cacbc497780934a0ae84ab363426", "159753159753", "qa27111985qa",
  "gfhjkmgfhjkm", "warhammer40k", "christopher1", "jonasbrothers", "sdf7asdf6asdg8df1",
  "cookiemonster", "edwardcullen", "avrillavigne", "gettherefast", "ilovemyfamily",
  "qazwsxedcrfvtgb", "cod12qw75rqyi59n", "qwertyuiop12", "q1w2e3r4t5y6u7", "huangjin1987",
  "lovelovelove", "password12345", "asd123asd123", "michaeljackson", "102030405060",
  "000000000000", "abc123abc123", "123123qweqwe", "qazwsx123456", "asdasd123123", "1234qwerasdf",
  "zaq1xsw2cde3", "doomsayer.2.7mords.vv", "565491d704013245", "typetogether", "asd123456789",
  "1234567891011", "stratocaster", "1qa2ws3ed4rf", "123456789zxc", "1234567891234567",
  "googlecheckout", "asdasdasd123", "123456789qaz", "blahblahblah", "trazenkvarel",
  "qwertyasdfgh", "transportonline", "1234567qwertyu", "aaaaaaaaaaaa", "123456789987",
  "2hgfhfghfgdfg", "finalfantasy7", "1q2w3e4r5t6y7u8i9o", "dragonslayer", "1234567890qwe",
  "123qwe456rty", "spiderman123", "ronaldinho10", "1234567890123", "ghhh47hj7649",
  "asdasdasdasd", "1q2w3e1q2w3e", "jesuslovesme", "123456789qwerty", "mortalkombat",
  "chocolate123", "qazxswedcvfr", "devilmaycry4", "fashionfantasy", "over2yangshuo",
  "whosyourdaddy", "islcollective", "qwerty123456789", "123qwerty123", "1234567890qw",
  "hakunamatata", "691b4dd30ff92343", "012345678910", "alexander123", "123456789000",
  "qwertyuiop12345", "asdfasdfasdf", "lol123456789", "a1s2d3f4g5h6", "jh5thrwgefsdfs",
  "heartbreaker", "pswd2011dlinkers", "deepfrequency", "zaq12wsxcde3", "12345678900987654321",
  "fucktheworld", "wasiryear0721", "modernwarfare2", "memyselfandi", "q1w2e3r4t5y6u7i8",
  "zxcvbnm12345", "manchesterunited", "qwertyytrewq", "iseedeadpeople", "basketball23",
  "asdfgh123456", "thienduong91", "fuckyoubitch", "1234567899876543", "a1b2c3d4e5f6",
  "12345678901234567890", "a1a2a3a4a5a6", "159357159357", "wocao5201314", "internazionale",
  "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "tyngsboro1234", "333001qwerty", "abuse_123456_abuse",
  "runescape123", "1111111111111111", "1q2w3e4r5t6y7u8", "harrypotter1", "passwordnoncree",
  "friends4ever", "1234567890qwertyuiop", "qwerty654321", "123456789lol", "159753456852",
  "qweqwe123123", "ghjcnjgfhjkm", "eldercarelink", "mangatraders", "123321qweewq",
  "123456789123456", "witspass1234", "seo21saafd23", "123456789aaa", "webmaster123",
  "narutouzumaki", "123456789012", "112233qqwwee", "123321456654", "16d7f906289d77b3",
  "supersuccess1", "neversaynever", "q1w2e3r4t5y6u7i8o9p0", "1a2s3d4f5g6h", "ilovefashion",
  "abcdef123456", "peaceandlove", "020332007051", "galatasaray1905", "sasukeuchiha",
  "ingodwetrust", "qazwsxedc123456", "homersimpson", "anastasija3010", "foreveryoung",
  "battlefield2", "123412341234", "1q2w3e4r5t6z", "sebastian123", "rachmaninoff", "kindergarten",
  "123456789101112", "ghbdtnrfrltkf", "werderbremen", "12345678987654321", "williamsburg",
  "gtasanandreas", "e10adc3949ba59abbe56", "systemofadown", "dragonmaster", "azerty123456",
  "spongebob123", "1qa2ws3ed4rf5tg", "worldofwarcraft", "1234567890qwerty", "azertyuiop123",
  "9749676621ok", "barcelona123", "cheeseburger", "skateboarding", "komltptfcorp",
  "014702580369", "splintercell", "foreveralone", "thdahaoren12", "happybirthday",
  "chesterfield", "123asd123asd", "1a2b3c4d5e6f", "iloveyoubaby", "oceanography", "zxcvbn123456",
  "basketball12", "qwe123456789", "qazxswedc123", "temppassword", "1a2a3a4a5a6a",
  "hellokitty123", "passwordzx3d56", "christian123", "fenerbahce1907", "hengsha_2_23",
  "cheerleading", "ghbdtnghbdtn", "111111111111111", "anthropogenic", "cosmopolitan",
  "metallica123", "159753852456", "lordoftherings", "dragonballgt", "galatasaray1",
  "7ed9b31268aa2b8a", "kingdomhearts2", "123456abcdef", "1q2w3e4r5t6y7", "qwertyuiopasdfg",
  "ujerfui8fjkd3", "89216279708a", "qwertyuiop1234567890", "mediacontact", "battlefield3",
  "sagopakajmer", "paralelepipedo", "gzdw14556wee", "iloveyousomuch", "architecture",
  "123123456456", "qwertyuiopasdfghjkl", "penguinator948", "1234qwerasdfzxcv", "password123456",
  "password_temporal", "powerrangers", "1234567890987654321", "1234567890123456", "construction",
  "winniethepooh", "12qw34er56ty", "njhygtftb567", "al#ks3!ksj0xx", "playstation1",
  "d41d8cd98f00", "preordination", "qwaszxqwaszx", "qwertyuiop1234", "appleiphones",
  "monsterhunter", "qwaszxerdfcv", "bogeissb2014", "optimusprime", "lol123lol123",
  "1234567890-=", "berwick2015zx3d56", "bismillah786", "qaz123wsx456", "goodcharlotte",
  "123456789qwer", "kobebryant24", "12345678vuonggialong", "butterfly123", "thisismypassword",
  "1233211234567", "internacional", "residentevil4", "mimamamemima", "123456789101",
  "massimiliano", "qazwsxqazwsx", "112233445566778899", "paperindex1*", "deadfrontier",
  "123qweasdyxc", "wgn529138165", "wrestlemania", "besiktas1903", "mindlessbehavior",
  "ukflbfnjh12345", "zxcvbnmzxcvbnm", "strawberries", "guilherme123", "poseinfopass",
  "l33tsupah4x0r", "showmethemoney", "winnipeg2612", "butterscotch", "qweqweqwe123",
  "alteclansing", "cambridgezx3d56", "12345678910a", "123456789abcd", "112358132134",
  "12345677654321", "1z2x3c4v5b6n", "registration", "pokemon12345", "assassinscreed",
  "z1x2c3v4b5n6", "uzumakinaruto", "7e9lnk55fcgg", "qawsedrftgyh", "queteimporta",
  "communication", "852456852456", "qwertyuiop123456", "abc123zx3d56", "vfvfvskfhfve",
  "schmetterling", "123qqqwwwsssaaa", "dreamtheater", "qwertyqwerty1", "102030102030",
  "qweasdqweasd", "123ewqasdcxz", "shootingstar", "hd764nw5d7e1vb1", "30secondstomars",
  "cheekymonkey", "159753258456", "1234567890qwert", "sanfrancisco", "zxc123456789",
  "123qazwsxedc", "fuckthisshit", "htt//members.cumfiesta.com/", "aaaaaaaaaaaaaaa",
  "philadelphia", "bobthebuilder", "friendsforever", "qwertasdfgzxcvb", "snowboarding",
  "010203010203", "qaz123456789", "blackandwhite", "cristianoronaldo", "qwertyuiopasdfgh",
  "827ccb0eea8a706c4c", "qwerty1234567", "abcdefghijkl", "thereisnospoon", "thedancerfam",
  "753951852456", "combat123654", "z1x2c3v4b5n6m7", "zxcvbnm1234567", "bismillah123",
  "zxcvbnm123456", "satisfaction", "prettyprincess", "hellogoodbye", "minecraft101",
  "xxxxxxxxxxxx", "zakkanet0000", "dothingocthuy", "dragonballz1", "1234567890qaz",
  "minecraft1234", "feridax082012", "qwertyuiopasdfghjklzxcvbnm", "1234567890abc",
  "avadakedavra", "flvbybcnhfnjh", "confidential", "metallica666", "qwerty123321",
  "zxcvbnm123456789", "encyclopedia", "rollercoaster", "123456789asdf", "q2w3e4r5t6y7u8i9o0",
  "pakistan1947", "123456asdfgh", "mississippi1", "asakakarun21", "butterfinger", "elvispresley",
  "11111111111111111111", "alejandro123", "pokemonmaster", "1qazxsw23edcvfr4", "qweasdzxcrfv",
  "dreamcatcher", "windowsvista", "peppermint00", "123abc123abc", "linkbuilding01",
  "asdfqwer1234", "1234567890vuonggialong", "1qa2ws3ed12345", "liverpool1892", "lost4815162342",
  "nightcrawler", "prettyinpink", "basketball11", "modernwarfare", "jesuschrist1",
  "popokatepetl", "asdfghjkl12345", "qwerasdf1234", "whysoserious", "mailinator2009",
  "riodejaneiro", "qwe123rty456", "inspiracija1", "1qay2wsx3edc", "fuckfuckfuck",
  "hedimaptfcorp", "love123456789", "zxcvbnmmnbvcxz", "djheu1254fre", "basketball123",
  "123012301230", "narutoshippuden", "110331rahili", "entertainment", "123456789789",
  "qwerty123qwerty", "angelofdeath", "qwertyasdfgzxcvb1234", "qw1er2ty3ui4op5", "killerkiller",
  "123456781122", "britneyspears", "zaqwsxcderfv", "supermario64", "asdfghjkl456",
  "12345678912345", "1234567890qwer", "orlandobloom", "1q2w3e4e3w2q", "michelangelo",
  "mercedesbenz", "qqwerty12345", "passwordpassword", "masterblaster", "07061985nina",
  "residentevil5", "anhnhoemnhieu", "ssssssssssss", "zaqxswcde123", "951753852456",
  "alhamdulillah", "vtuf36jhufpv", "jh5thrwgefsdf", "stratovarius", "charliebrown",
  "sti11holding", "todotorrents", "123456789852", "123456zx3d56", "gamerzplanet",
  "123456789qwert", "nckucynesluixm", "independence", "qazwsxedc12345", "h54rsjrf5j123",
  "tequieromucho", "livelaughlove", "streetfighter", "snowboardru55", "haveaniceday",
  "password2010", "evangelion01", "qwertyuio890", "reymysterio619", "1234567891011121",
  "silmarillion", "1234567890asd", "asdfghjklzxcvbnm", "ersguterjunge", "holidaysecure123$",
  "vothien110791", "4815162342lost", "159357258456", "bvkmosrus2010", "crossfire123",
  "111222tianya", "alleniverson", "minecraft12345", "zxc123zxc123", "accountblock",
  "devilmaycry3", "qaz1wsx2edc3", "aaqsqareeplq6", "mariaeduarda", "1234567vuonggialong",
  "unitedstates", "1234qwer1234", "iloveyou1234", "mylittlepony", "741085209630",
  "gofuckyourself", "h54rsjrf5j46788998", "null_from_api", "findaupair007", "ihatehackers",
  "000webhost.com", "submitted123", "cha1xun3tian", "lebronjames23", "kuroshitsuji",
  "chiyeuminhem", "vampireknight", "qweewq123321", "watermelon123", "555555555555",
  "modernwarfare3", "frankenstein", "cheapassgamer", "ageofempires", "jeremiah2911",
  "preetibuffy99", "abc123def456", "123qweasdzxc123", "aaaaaaaaaaaaaaaa", "grandtheftauto",
  "necronomicon", "avenged7fold", "basketball13", "hunterxhunter", "deutschland1",
  "justinbieber1", "underground1", "mamanjetaime", "avengedsevenfold", "manchester123",
  "ilovejustinbieber", "dancingqueen", "nastyanastya", "123123123qwe", "abcdefg12345",
  "alihassan123", "liverpoolfc1", "punksnotdead", "zaqxswcdevfr", "111222333444",
  "dallascowboys", "111122223333", "qwertyuiopas", "underground2", "alexandre123",
  "basketball10", "blacksabbath", "harrypotter7", "123456zxcvbn", "akusayangkamu",
  "feuerwehr112", "greenlantern", "holidaysecure123", "nikitanikita", "qwertyuiop123456789",
  "bananaroof674", "123456789qqq", "arquitectura", "civilization",
  "$hex[636f6e7472617365c3b161]", "loveandpeace", "silversurfer", "thisissparta", "narutosasuke",
  "newpassword1", "qazwsxedc1234", "hellokitty12", "manojmanoj87", "inalienability",
  "plmqazwsx123", "taylorlautner", "motherfucker1", "worldoftanks", "iloveyou4ever",
  "m1996m2928443", "mustanggt500", "polya123ma456", "senbonzakura", "homesweethome",
  "1234567890as", "sharpshooter", "crosscountry", "denya2531914", "adf8h4zikg73", "nam123456789",
  "thegathering", "sebelasmaret1984", "htt//www.just18.com/members/", "akucintakamu",
  "californication", "lightning129", "milko12345677", "owner@hr.com", "i234i234i234",
  "ilovemymommy", "saun24865709", "hastings1066", "ilovecookies", "alexandra123",
  "123456789012345", "hlin123456789", "q1w2e3q1w2e3", "basketball22", "pakistan12345",
  "aida2013sales", "finalfantasy8", "clashofclans", "clientesvpauto", "qwerty1234567890",
  "indianajones", "nissanskyline", "q2w3e4r5t6y7", "112233112233", "finalfantasy12",
  "eladnbin1104", "superstar123", "0000000000000000", "g00dpa$$w0rd", "1z2x3c4v5b6n7m",
  "abcd123456789", "aq111asd1qast", "facebook.com", "loop1206ssdsff", "12345qwertasdfg",
  "123qwe456asd", "allahisgreat", "holacomoestas", "password@123", "uchihasasuke",
  "nuttertools1", "123045607890", "accessdenied", "lulu889jdddd", "amadeusptfcorp",
  "intervention", "newfoundland", "thunderstorm", "0123456789vuonggialong", "breakingdawn",
  "222222222222", "abcdefghijklmnop", "dsrt47mbujil", "7e9lnkd3fc01", "cradleoffilth",
  "159951159951", "thecakeisalie", "11qq22ww33ee", "cherryblossom", "manchester12",
  "zxcvbnmasdfghjkl", "11111111111111", "playstation4", "princeofpersia", "harleydavidson",
  "mastermaster", "121212121212", "1234567890098765", "123qweasd123", "iloveyou1314",
  "finalfantasy10", "1234567890aa", "lamborghini1", "praisethelord", "qwertyuiop789",
  "blackpanther", "1234567654321", "justinbieber123", "fkmnthyfnbdf", "пїѕпїѕпїѕпїѕпїѕпїѕ",
  "007jamesbond", "swordartonline", "aaaa12345678", "elizabeth123", "??????????????????",
  "??????????????????????????????", "happynewyear", "lionelmessi10", "ilovemydaddy",
  "1234567qwerty", "446a12100c856ce9", "11223344556677", "migrationschool", "monkeydluffy",
  "iliketurtles", "independiente", "jabbawockeez", "qwertyu1234567", "stonecold316",
  "iloveminecraft", "vfrcbvvfrcbv", "hurensohn123", "naruto123456", "jundian2012xr",
  "australia123", "123abc456def", "pakistan1234", "justinbeiber", "qwertyuiop[]",
  "abcdefghijklmnopqrstuvwxyz", "cgfzc3dvcmq=", "dkflbvbhjdbx", "thesummer123", "12345671234567",
  "123456789456", "asdfghjkl1234", "metalgearsolid", "dddddddddddd", "ilovemyindia",
  "mama123456789", "mychemicalromance", "999999999999", "mama0107415613", "medalofhonor",
  "qwerty123123", "aaa123456789", "teamfortress2", "2gether4ever", "robertpattinson",
  "pincopallino", "poiuytrewq123", "harrypotter123", "1122334455667788", "159357456852",
  "zheng2191015", "basketball15", "htt//members.ztod.com/", "stormtrooper", "123456789963",
  "jessemccartney", "010203040506070809", "kingdomheart", "malwarebytes", "woshitiancai",
  "102030405060708090", "herrderringe", "velociraptor", "venividivici", "012301230123",
  "brigid1zx3d56", "masya2023232", "trunghai1179", "1111111111111", "123456789www",
  "awesomesauce", "friedchicken", "lavieestbelle", "tinkerbell123", "universitario",
  "7253497a5e31bd64", "tinkerbell12", "hastalavista", "ilovethisgame", "q1w2e3r4t5z6",
  "borderlands2", "informatique", "blablabla123", "passhaslo123", "silverbullet",
  "blackveilbrides", "123456789qwertyu", "basketball14", "holasoygerman", "microsoft123",
  "ironmaiden666", "marijuana420", "123456789qwertyuiop", "lasvegas0123", "link07232011",
  "q1a2z3w4s5x6", "thegodfather", "123qwertyuiop", "linkinpark123", "blckd_sa_unpaidfee_oct06",
  "bountyhunter", "jafjkshf7y6w34rjd", "111222333000", "asdfghjkl123456", "mynameiskhan",
  "picpost_type_id", "77448965tony", "qweasd123456", "qweqweqweqwe", "8cb65a907f14d60005",
  "osnload12-10-08", "danieldaniel", "finalfantasy1", "masterchief1", "password2012",
  "qweasdzxc12345", "1234567887654321", "12345678qwertyui", "daniel123456", "legendkiller",
  "marilynmanson", "adventuretime", "dkflbvbhjdyf", "sherlockholmes", "159357852456",
  "masterchief117", "y6t5r4e3w2q1", "fruitsbasket", "linkedin2011", "qazwsxedcrfv123",
  "alex123456789", "shahrukhkhan", "basketball24", "qaz123qaz123", "qwe123asd456",
  "neverbackdown", "polatalemdar", "qazwsxedcrfvtgby", "89066332577q", "amazinggrace",
  "minhasenha123", "anhyeuemnhieu", "middlesbrough", "swaminarayan", "thunderbirds",
  "1q2q3q4q5q6q", "1q2w3e3e2w1q", "fktrcfylhjdbx", "q7w8e9a4s5d6", "12345678910q",
  "alertpaydouble", "iloveyouforever", "1234567891234", "123456789zxcvbnm", "????????????",
  "mickeymouse1", "vthctltcs600", "123123321321", "q1q2q3q4q5q6", "davidbeckham", "ilovemichael",
  "sattarov1975", "tivogliobene", "spidermonkey", "12345678qwer", "amominhafamilia",
  "welcome12345", "finalfantasy13", "qwertyuiop11", "123123123123123", "aabbcc112233",
  "basketball21", "superman1234", "qwe1asd2zxc3", "ciaociaociao", "iloveyoubabe", "123zxc123zxc",
  "determination", "taylorswift13", "159753123456", "ghostbusters", "tobeornottobe",
  "1q2w3eazsxdc", "callofduty123", "juventus1897", "monsterenergy", "1234567812345678",
  "azertyuiop789", "fernandotorres", "football1234", "panathinaikos", "azertyazerty",
  "livelovelaugh", "undertaker12", "ensicptfcorp", "geibcnbr1994", "liveyourlife",
  "password123456789", "serioussam25", "bioshock12345", "ichliebedich1", "lollollol123",
  "lolsmileyface", "drm199019902323", "suppersuccess1", "password2009", "iloveanimals",
  "panasonic123", "sexonthebeach", "happygolucky", "thanhtuyetvuonggialong", "alexandru123",
  "1qaz1qaz1qaz", "stephanie123", "stormbringer", "123456qazwsx", "654321123456",
  "warhammer40000", "1234567890qq", "cxzdsaewq321", "fuckthepolice", "onomatopoeia",
  "asdfghjkl123456789", "jacksonville", "greedisgo123", "fishandchips", "ihatepasswords",
  "ilshofen0926", "666666666666", "1qw23er45ty6", "d41d8cd98f00b204e980", "122333444455555",
  "???????????????", "dgenerationx", "fktrcfylhjdyf", "policeauctions", "qwerty12345678",
  "theundertaker",
];

export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(COMMON_PASSWORD_LIST);
export const LONG_COMMON_PASSWORDS: ReadonlySet<string> = new Set(LONG_COMMON_PASSWORD_LIST);

/** The shortest stem worth judging: below this a trailing-digit strip leaves
 * noise rather than a word (`1q2w3e4r` -> `q`), and the whole-list checks above
 * already cover the real strings. */
const MIN_STEM_LENGTH = 4;

/**
 * What is left of a password once the padding a person adds to clear a length
 * floor is removed: trailing digits, punctuation and separators (which covers a
 * trailing year). `iloveyou2026!` -> `iloveyou`, `password1234` -> `password`.
 * Returns null when nothing usable remains.
 */
export function passwordStem(password: string): string | null {
  const stem = password.trim().toLowerCase().replace(/[^a-z]+$/u, "");
  return stem.length >= MIN_STEM_LENGTH ? stem : null;
}

/** Case-insensitive membership in the common-password blacklist: the password
 * itself in either list, or a familiar word wearing a numeric tail. */
export function isCommonPassword(password: string): boolean {
  const normalized = password.trim().toLowerCase();
  if (COMMON_PASSWORDS.has(normalized) || LONG_COMMON_PASSWORDS.has(normalized)) {
    return true;
  }
  const stem = passwordStem(normalized);
  return stem !== null && stem !== normalized && COMMON_PASSWORDS.has(stem);
}

/** The §4.2 rule for a password chosen through a link: 12-256 characters and not
 * in the blacklist. Pure; the kernel and the dashboard call the same function. */
export function checkNewPassword(password: string): PasswordPolicyVerdict {
  if (password.length < PASSWORD_MIN_LENGTH) return "too_short";
  if (password.length > PASSWORD_MAX_LENGTH) return "too_long";
  if (isCommonPassword(password)) return "common";
  return "ok";
}

/** Static, dictionary-safe wording (§2: no "token", "key", "API"). */
export const PASSWORD_POLICY_MESSAGES: Record<Exclude<PasswordPolicyVerdict, "ok">, string> = {
  too_short: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long`,
  too_long: `Password must be at most ${PASSWORD_MAX_LENGTH} characters long`,
  common: "This password is too common; choose a less predictable one",
};
