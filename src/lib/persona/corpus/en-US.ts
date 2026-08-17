import { between, digits, type Corpus, type Place } from './corpus';

/**
 * United States.
 *
 * Places are real, with the ZIP prefix each city actually owns, so a generated
 * address passes the sort of validation a checkout form does. People and streets
 * are invented from parts.
 *
 * **Phone numbers use the 555-0100…555-0199 block on purpose.** North American
 * numbering reserves it for fiction, so nothing this generates can ring a real
 * person — which matters more here than realism, because a tester filling a form
 * on a live system may well cause it to dial.
 *
 * No national identifier. A Social Security number has no check digit, so a
 * generated one is indistinguishable from a real one, and the areas that were
 * never issued are a moving target. Swiss AHV numbers are emitted because they
 * carry a checksum that marks them as constructed; the same argument does not
 * hold here, so `nationalId` is `undefined` rather than a plausible SSN.
 */

const FIRST_NAMES = [
  'Aaliyah', 'Aaron', 'Abigail', 'Adam', 'Adrian', 'Aiden', 'Alan', 'Alexa', 'Alexander', 'Alice',
  'Alicia', 'Allison', 'Amanda', 'Amara', 'Amelia', 'Amir', 'Andre', 'Andrea', 'Andrew', 'Angela',
  'Anita', 'Anthony', 'Antonio', 'April', 'Arjun', 'Arthur', 'Ashley', 'Aubrey', 'Audrey', 'Austin',
  'Ava', 'Avery', 'Barbara', 'Beatrice', 'Benjamin', 'Bernard', 'Beth', 'Blake', 'Bradley', 'Brandon',
  'Brenda', 'Brian', 'Brianna', 'Brooke', 'Bryan', 'Caleb', 'Cameron', 'Camila', 'Carl', 'Carla',
  'Carlos', 'Carmen', 'Carol', 'Caroline', 'Carter', 'Casey', 'Cassandra', 'Catherine', 'Cecilia', 'Chad',
  'Charles', 'Charlotte', 'Chelsea', 'Cheryl', 'Chloe', 'Christian', 'Christina', 'Christopher', 'Claire', 'Clara',
  'Clarence', 'Claudia', 'Clayton', 'Cole', 'Colin', 'Connor', 'Corey', 'Courtney', 'Craig', 'Crystal',
  'Curtis', 'Cynthia', 'Daisy', 'Dale', 'Damon', 'Daniel', 'Danielle', 'Darren', 'David', 'Dawn',
  'Dean', 'Deborah', 'Declan', 'Denise', 'Dennis', 'Derek', 'Desmond', 'Devin', 'Diana', 'Diego',
  'Dominic', 'Donald', 'Donna', 'Dorothy', 'Douglas', 'Dylan', 'Edward', 'Eileen', 'Elaine', 'Eleanor',
  'Elena', 'Eli', 'Elias', 'Elijah', 'Elizabeth', 'Ella', 'Ellen', 'Emily', 'Emma', 'Eric',
  'Erica', 'Erin', 'Ernest', 'Esther', 'Ethan', 'Eugene', 'Evan', 'Evelyn', 'Faith', 'Felix',
  'Fernando', 'Fiona', 'Frances', 'Francis', 'Frank', 'Franklin', 'Gabriel', 'Gabriella', 'Gary', 'Gavin',
  'Genevieve', 'George', 'Georgia', 'Gerald', 'Gina', 'Glenn', 'Gloria', 'Gordon', 'Grace', 'Grant',
  'Gregory', 'Hailey', 'Hannah', 'Harold', 'Harper', 'Harrison', 'Hazel', 'Heather', 'Hector', 'Helen',
  'Henry', 'Holly', 'Hunter', 'Ian', 'Imani', 'Irene', 'Isaac', 'Isabella', 'Isaiah', 'Ivan',
  'Jacob', 'Jade', 'James', 'Jamie', 'Jane', 'Janet', 'Jared', 'Jasmine', 'Jason', 'Javier',
  'Jean', 'Jeffrey', 'Jenna', 'Jennifer', 'Jeremy', 'Jerome', 'Jesse', 'Jessica', 'Joan', 'Joanna',
  'Joel', 'John', 'Jonathan', 'Jordan', 'Jorge', 'Joseph', 'Joshua', 'Joy', 'Juan', 'Judith',
  'Julia', 'Julian', 'Justin', 'Kaitlyn', 'Karen', 'Katherine', 'Kathleen', 'Kayla', 'Keith', 'Kelly',
  'Kenneth', 'Kevin', 'Kimberly', 'Kyle', 'Lance', 'Larry', 'Laura', 'Lauren', 'Lawrence', 'Leah',
  'Leo', 'Leon', 'Leonard', 'Leslie', 'Levi', 'Liam', 'Lila', 'Lillian', 'Linda', 'Lisa',
  'Logan', 'Lorraine', 'Louis', 'Lucas', 'Lucia', 'Lucy', 'Luis', 'Luke', 'Lydia', 'Lyle',
  'Mabel', 'Madeline', 'Madison', 'Malcolm', 'Marcus', 'Margaret', 'Maria', 'Marie', 'Marilyn', 'Mario',
  'Marion', 'Mark', 'Marlene', 'Martha', 'Martin', 'Mary', 'Mason', 'Matthew', 'Maureen', 'Maxwell',
  'Maya', 'Megan', 'Melanie', 'Melissa', 'Mercedes', 'Meredith', 'Micah', 'Michael', 'Michelle', 'Miguel',
  'Miles', 'Miranda', 'Mitchell', 'Molly', 'Monica', 'Morgan', 'Nadia', 'Naomi', 'Natalie', 'Nathan',
  'Neil', 'Nicholas', 'Nicole', 'Noah', 'Nolan', 'Nora', 'Norman', 'Olivia', 'Omar', 'Oscar',
  'Owen', 'Paige', 'Pamela', 'Patricia', 'Patrick', 'Paul', 'Paula', 'Pedro', 'Penelope', 'Peter',
  'Philip', 'Phoebe', 'Priya', 'Quinn', 'Rachel', 'Ralph', 'Ramon', 'Randall', 'Raymond', 'Rebecca',
  'Regina', 'Renee', 'Reuben', 'Ricardo', 'Richard', 'Riley', 'Rita', 'Robert', 'Roberta', 'Robin',
  'Rodney', 'Roger', 'Ronald', 'Rosa', 'Rosemary', 'Ross', 'Roy', 'Ruby', 'Russell', 'Ruth',
  'Ryan', 'Sabrina', 'Samantha', 'Samuel', 'Sandra', 'Sara', 'Scott', 'Sean', 'Sebastian', 'Selena',
  'Serena', 'Seth', 'Shane', 'Shannon', 'Sharon', 'Shawn', 'Sheila', 'Shelby', 'Sierra', 'Simon',
  'Sofia', 'Solomon', 'Sonia', 'Sophia', 'Spencer', 'Stanley', 'Stella', 'Stephanie', 'Stephen', 'Steven',
  'Stuart', 'Susan', 'Sydney', 'Sylvia', 'Tanya', 'Tara', 'Taylor', 'Teresa', 'Terrence', 'Thelma',
  'Theodore', 'Theresa', 'Thomas', 'Tiffany', 'Timothy', 'Tobias', 'Todd', 'Tracy', 'Travis', 'Trevor',
  'Tristan', 'Tyler', 'Valerie', 'Vanessa', 'Vernon', 'Veronica', 'Victor', 'Victoria', 'Vincent', 'Violet',
  'Virginia', 'Vivian', 'Walter', 'Warren', 'Wayne', 'Wendy', 'Wesley', 'Whitney', 'William', 'Willow',
  'Wyatt', 'Xavier', 'Yolanda', 'Yvonne', 'Zachary', 'Zoe',
];

const LAST_NAMES = [
  'Abbott', 'Adams', 'Aguilar', 'Alexander', 'Allen', 'Alvarez', 'Anderson', 'Andrews', 'Armstrong', 'Arnold',
  'Ashford', 'Atkinson', 'Austin', 'Bailey', 'Baker', 'Baldwin', 'Ballard', 'Banks', 'Barker', 'Barnes',
  'Barnett', 'Barrett', 'Bartlett', 'Barton', 'Bass', 'Bates', 'Beasley', 'Beck', 'Bell', 'Bennett',
  'Benson', 'Bentley', 'Berry', 'Best', 'Bishop', 'Black', 'Blackwell', 'Blair', 'Blake', 'Blevins',
  'Bond', 'Booker', 'Boone', 'Booth', 'Bowen', 'Bowers', 'Bowman', 'Boyd', 'Boyle', 'Bradford',
  'Bradley', 'Brady', 'Branch', 'Brennan', 'Brewer', 'Bridges', 'Briggs', 'Bright', 'Brock', 'Brooks',
  'Brown', 'Bryant', 'Buchanan', 'Buckley', 'Bullock', 'Burgess', 'Burke', 'Burns', 'Burton', 'Bush',
  'Butler', 'Byrd', 'Cabrera', 'Cain', 'Caldwell', 'Calhoun', 'Callahan', 'Cameron', 'Campbell', 'Cannon',
  'Cardenas', 'Carey', 'Carlson', 'Carpenter', 'Carr', 'Carroll', 'Carson', 'Carter', 'Case', 'Casey',
  'Castillo', 'Castro', 'Chambers', 'Chan', 'Chandler', 'Chang', 'Chapman', 'Chase', 'Chavez', 'Chen',
  'Christensen', 'Clark', 'Clarke', 'Clayton', 'Clements', 'Cline', 'Cobb', 'Cochran', 'Coffey', 'Cohen',
  'Cole', 'Coleman', 'Collier', 'Collins', 'Colon', 'Combs', 'Compton', 'Conley', 'Connelly', 'Conner',
  'Conrad', 'Contreras', 'Conway', 'Cook', 'Cooke', 'Cooley', 'Cooper', 'Copeland', 'Cortez', 'Costa',
  'Cotton', 'Cox', 'Craft', 'Craig', 'Crane', 'Crawford', 'Crosby', 'Cross', 'Cruz', 'Cummings',
  'Cunningham', 'Curry', 'Curtis', 'Dalton', 'Daniels', 'Davenport', 'Davidson', 'Davis', 'Dawson', 'Dean',
  'Decker', 'Delacruz', 'Delgado', 'Dennis', 'Diaz', 'Dickerson', 'Dickson', 'Dillon', 'Dixon', 'Dodson',
  'Dominguez', 'Donaldson', 'Donovan', 'Dorsey', 'Douglas', 'Downs', 'Doyle', 'Drake', 'Duarte', 'Dudley',
  'Duffy', 'Duke', 'Duncan', 'Dunlap', 'Dunn', 'Duran', 'Durham', 'Dyer', 'Eaton', 'Edwards',
  'Elliott', 'Ellis', 'Ellison', 'English', 'Erickson', 'Escobar', 'Espinoza', 'Estes', 'Estrada', 'Evans',
  'Everett', 'Farley', 'Farmer', 'Farrell', 'Faulkner', 'Ferguson', 'Fernandez', 'Fields', 'Figueroa', 'Finch',
  'Finley', 'Fischer', 'Fisher', 'Fitzgerald', 'Fleming', 'Fletcher', 'Flores', 'Flowers', 'Floyd', 'Flynn',
  'Foley', 'Forbes', 'Ford', 'Foreman', 'Foster', 'Fowler', 'Fox', 'Francis', 'Franco', 'Frank',
  'Franklin', 'Frazier', 'Frederick', 'Freeman', 'French', 'Frost', 'Fry', 'Fuentes', 'Fuller', 'Gaines',
  'Gallagher', 'Gallegos', 'Galloway', 'Garcia', 'Gardner', 'Garner', 'Garrett', 'Garrison', 'Garza', 'Gates',
  'Gentry', 'George', 'Gibbs', 'Gibson', 'Gilbert', 'Giles', 'Gill', 'Gillespie', 'Glass', 'Glenn',
  'Glover', 'Golden', 'Gomez', 'Gonzales', 'Goodman', 'Goodwin', 'Gordon', 'Gould', 'Grace', 'Graham',
  'Grant', 'Graves', 'Gray', 'Green', 'Greene', 'Greer', 'Gregory', 'Griffin', 'Griffith', 'Grimes',
  'Gross', 'Guerra', 'Guerrero', 'Gutierrez', 'Guzman', 'Hahn', 'Hale', 'Haley', 'Hall', 'Hamilton',
  'Hammond', 'Hampton', 'Hancock', 'Haney', 'Hansen', 'Hanson', 'Hardin', 'Harding', 'Hardy', 'Harmon',
  'Harper', 'Harrell', 'Harrington', 'Harris', 'Harrison', 'Hart', 'Hartman', 'Harvey', 'Hastings', 'Hatfield',
  'Hawkins', 'Hayden', 'Hayes', 'Haynes', 'Hays', 'Head', 'Heath', 'Hebert', 'Henderson', 'Hendricks',
  'Henry', 'Hensley', 'Herman', 'Hernandez', 'Herrera', 'Herring', 'Hess', 'Hester', 'Hewitt', 'Hickman',
  'Hicks', 'Higgins', 'Hill', 'Hines', 'Hobbs', 'Hodge', 'Hoffman', 'Hogan', 'Holcomb', 'Holden',
  'Holder', 'Holland', 'Holloway', 'Holmes', 'Holt', 'Hood', 'Hooper', 'Hoover', 'Hopkins', 'Horn',
  'Horne', 'Horton', 'House', 'Houston', 'Howard', 'Howe', 'Howell', 'Hubbard', 'Huber', 'Hudson',
  'Huff', 'Huffman', 'Hughes', 'Hull', 'Humphrey', 'Hunt', 'Hunter', 'Hurley', 'Hurst', 'Hutchinson',
  'Ingram', 'Irwin', 'Jackson', 'Jacobs', 'Jacobson', 'James', 'Jarvis', 'Jefferson', 'Jenkins', 'Jennings',
  'Jensen', 'Jimenez', 'Johns', 'Johnson', 'Johnston', 'Jones', 'Jordan', 'Joseph', 'Joyce', 'Juarez',
  'Kane', 'Kaufman', 'Keith', 'Keller', 'Kelley', 'Kelly', 'Kemp', 'Kennedy', 'Kent', 'Kerr',
  'Key', 'Kim', 'King', 'Kinney', 'Kirby', 'Kirk', 'Klein', 'Knight', 'Knox', 'Koch',
  'Kramer', 'Lamb', 'Lambert', 'Lancaster', 'Landry', 'Lane', 'Lang', 'Langley', 'Lara', 'Larsen',
  'Larson', 'Lawrence', 'Lawson', 'Le', 'Leach', 'Leblanc', 'Lee', 'Leon', 'Leonard', 'Lester',
  'Levine', 'Levy', 'Lewis', 'Lindsey', 'Little', 'Livingston', 'Lloyd', 'Logan', 'Long', 'Lopez',
  'Love', 'Lowe', 'Lucas', 'Luna', 'Lynch', 'Lyons', 'Macdonald', 'Mack', 'Madden', 'Maddox',
  'Mahoney', 'Maldonado', 'Malone', 'Mann', 'Manning', 'Marks', 'Marquez', 'Marsh', 'Marshall', 'Martin',
  'Martinez', 'Mason', 'Mathews', 'Mathis', 'Matthews', 'Maxwell', 'May', 'Maynard', 'Mayo', 'Mays',
  'McBride', 'McCall', 'McCarthy', 'McClain', 'McConnell', 'McCormick', 'McCoy', 'McCullough', 'McDaniel', 'McDonald',
  'McDowell', 'McFadden', 'McGee', 'McGuire', 'McIntosh', 'McKay', 'McKee', 'McKenzie', 'McKinney', 'McLaughlin',
  'McLean', 'McMahon', 'McMillan', 'McNeil', 'McPherson', 'Meadows', 'Medina', 'Mejia', 'Melton', 'Mendez',
  'Mendoza', 'Mercado', 'Mercer', 'Merritt', 'Meyer', 'Meyers', 'Michael', 'Middleton', 'Miles', 'Miller',
  'Mills', 'Miranda', 'Mitchell', 'Molina', 'Monroe', 'Montgomery', 'Montoya', 'Moody', 'Moon', 'Mooney',
  'Moore', 'Morales', 'Moran', 'Moreno', 'Morgan', 'Morris', 'Morrison', 'Morrow', 'Morse', 'Morton',
  'Moses', 'Mosley', 'Moss', 'Mueller', 'Mullen', 'Mullins', 'Munoz', 'Murphy', 'Murray', 'Myers',
  'Nash', 'Navarro', 'Neal', 'Nelson', 'Newman', 'Newton', 'Nguyen', 'Nichols', 'Nielsen', 'Nixon',
  'Noble', 'Nolan', 'Norman', 'Norris', 'Norton', 'Nunez', 'Obrien', 'Ochoa', 'Oconnor', 'Odonnell',
  'Oliver', 'Olsen', 'Olson', 'Oneal', 'Oneill', 'Orr', 'Ortega', 'Ortiz', 'Osborne', 'Owen',
  'Owens', 'Pace', 'Pacheco', 'Padilla', 'Page', 'Palmer', 'Park', 'Parker', 'Parks', 'Parrish',
  'Parsons', 'Patel', 'Patrick', 'Patterson', 'Patton', 'Paul', 'Payne', 'Pearson', 'Peck', 'Pena',
  'Pennington', 'Perez', 'Perkins', 'Perry', 'Peters', 'Petersen', 'Peterson', 'Petty', 'Phelps', 'Phillips',
  'Pierce', 'Pittman', 'Pitts', 'Pope', 'Porter', 'Potter', 'Potts', 'Powell', 'Powers', 'Pratt',
  'Preston', 'Price', 'Prince', 'Pruitt', 'Puckett', 'Quinn', 'Ramirez', 'Ramos', 'Ramsey', 'Randall',
  'Randolph', 'Rasmussen', 'Ratliff', 'Ray', 'Raymond', 'Reed', 'Reese', 'Reeves', 'Reid', 'Reilly',
  'Reyes', 'Reynolds', 'Rhodes', 'Rice', 'Rich', 'Richard', 'Richards', 'Richardson', 'Richmond', 'Riddle',
  'Riggs', 'Riley', 'Rios', 'Rivas', 'Rivera', 'Rivers', 'Roach', 'Robbins', 'Roberson', 'Roberts',
  'Robertson', 'Robinson', 'Robles', 'Rocha', 'Rodgers', 'Rodriguez', 'Rogers', 'Rojas', 'Rollins', 'Roman',
  'Romero', 'Rosales', 'Rose', 'Ross', 'Roth', 'Rowe', 'Rowland', 'Roy', 'Rush', 'Russell',
  'Russo', 'Ryan', 'Salas', 'Salazar', 'Salinas', 'Sampson', 'Sanchez', 'Sanders', 'Sandoval', 'Sanford',
  'Santana', 'Santiago', 'Santos', 'Sargent', 'Saunders', 'Savage', 'Sawyer', 'Schaefer', 'Schmidt', 'Schneider',
  'Schroeder', 'Schultz', 'Schwartz', 'Scott', 'Sears', 'Sellers', 'Serrano', 'Sexton', 'Shaffer', 'Shannon',
  'Sharp', 'Shaw', 'Shelton', 'Shepard', 'Shepherd', 'Sheppard', 'Sherman', 'Shields', 'Short', 'Silva',
  'Simmons', 'Simon', 'Simpson', 'Sims', 'Singleton', 'Skinner', 'Slater', 'Sloan', 'Small', 'Smith',
  'Snider', 'Snow', 'Snyder', 'Solis', 'Solomon', 'Sosa', 'Soto', 'Sparks', 'Spears', 'Spence',
  'Spencer', 'Stafford', 'Stanley', 'Stanton', 'Stark', 'Steele', 'Stein', 'Stephens', 'Stephenson', 'Stevens',
  'Stevenson', 'Stewart', 'Stokes', 'Stone', 'Stout', 'Strickland', 'Strong', 'Stuart', 'Suarez', 'Sullivan',
  'Summers', 'Sutton', 'Swanson', 'Sweeney', 'Sykes', 'Talley', 'Tanner', 'Tate', 'Taylor', 'Terrell',
  'Terry', 'Thomas', 'Thompson', 'Thornton', 'Tillman', 'Todd', 'Torres', 'Townsend', 'Tran', 'Travis',
  'Trevino', 'Trujillo', 'Tucker', 'Turner', 'Tyler', 'Underwood', 'Valdez', 'Valencia', 'Valentine', 'Vance',
  'Vang', 'Vargas', 'Vasquez', 'Vaughan', 'Vaughn', 'Vega', 'Velasquez', 'Velez', 'Villarreal', 'Vincent',
  'Wade', 'Wagner', 'Walker', 'Wall', 'Wallace', 'Waller', 'Walls', 'Walsh', 'Walters', 'Walton',
  'Ward', 'Ware', 'Warner', 'Warren', 'Washington', 'Waters', 'Watkins', 'Watson', 'Watts', 'Weaver',
  'Webb', 'Weber', 'Webster', 'Weeks', 'Weiss', 'Welch', 'Wells', 'West', 'Wheeler', 'Whitaker',
  'White', 'Whitehead', 'Whitfield', 'Whitley', 'Whitney', 'Wiggins', 'Wilcox', 'Wilder', 'Wiley', 'Wilkerson',
  'Wilkins', 'Wilkinson', 'Williams', 'Williamson', 'Willis', 'Wilson', 'Winters', 'Wise', 'Wolf', 'Wolfe',
  'Wong', 'Wood', 'Woodard', 'Woods', 'Woodward', 'Wooten', 'Workman', 'Wright', 'Wyatt', 'Yang',
  'Yates', 'York', 'Young', 'Zamora', 'Zimmerman',
];

/** Combined with the suffixes below; neither half is a street on its own. */
const STREET_STEMS = [
  'Alder', 'Amber', 'Anchor', 'Applegate', 'Arbor', 'Ashland', 'Aspen', 'Autumn', 'Baldwin', 'Bayberry',
  'Beacon', 'Bellflower', 'Birchwood', 'Blackthorn', 'Bluebell', 'Bramble', 'Briarwood', 'Brightwater', 'Brookdale', 'Buckthorn',
  'Cambria', 'Candlewood', 'Cardinal', 'Cascade', 'Cedar', 'Chandler', 'Chestnut', 'Cinnamon', 'Clearbrook', 'Clover',
  'Cobblestone', 'Copperfield', 'Cottonwood', 'Cranberry', 'Crescent', 'Crestview', 'Cypress', 'Daffodil', 'Dogwood', 'Driftwood',
  'Eaglecrest', 'Eastgate', 'Elderberry', 'Elmwood', 'Everglade', 'Fairhaven', 'Falcon', 'Fernbank', 'Firethorn', 'Flintlock',
  'Foxglove', 'Gardenia', 'Glenhaven', 'Goldenrod', 'Granite', 'Greenbriar', 'Grovemont', 'Harvest', 'Hawthorn', 'Hazelwood',
  'Heatherfield', 'Hemlock', 'Heron', 'Hickory', 'Highgrove', 'Hollyberry', 'Honeysuckle', 'Huntington', 'Indigo', 'Ivywood',
  'Jasmine', 'Junipero', 'Kestrel', 'Kingfisher', 'Lakeshore', 'Lantern', 'Larkspur', 'Laurelwood', 'Lavender', 'Lilac',
  'Limestone', 'Lindenwood', 'Longmeadow', 'Magnolia', 'Mallard', 'Maplewood', 'Marigold', 'Meadowbrook', 'Millstone', 'Mistletoe',
  'Moonstone', 'Mulberry', 'Nightingale', 'Northfield', 'Oakhurst', 'Oleander', 'Orchard', 'Oriole', 'Overlook', 'Paddington',
  'Palisade', 'Parkview', 'Peartree', 'Pebblebrook', 'Peregrine', 'Periwinkle', 'Pinecrest', 'Poplar', 'Primrose', 'Quailridge',
  'Quarrystone', 'Ravenswood', 'Redbud', 'Riverbend', 'Rosewood', 'Sagebrush', 'Sandalwood', 'Sequoia', 'Shadowbrook', 'Sheffield',
  'Silverleaf', 'Snowberry', 'Sorrel', 'Springhill', 'Stonebridge', 'Sugarmaple', 'Summerfield', 'Sunflower', 'Sweetgum', 'Sycamore',
  'Tanglewood', 'Thistledown', 'Thornbury', 'Timberline', 'Trillium', 'Tumbleweed', 'Verdant', 'Vineyard', 'Wagonwheel', 'Walnut',
  'Waterford', 'Westbrook', 'Wheatfield', 'Whispering', 'Wildflower', 'Willowbrook', 'Windermere', 'Winterberry', 'Wisteria', 'Woodhaven',
];

const STREET_SUFFIXES = [
  'Street', 'Avenue', 'Road', 'Lane', 'Drive', 'Court', 'Place', 'Terrace', 'Way', 'Boulevard',
  'Circle', 'Trail',
];

const ORGANISATION_STEMS = [
  'Northwind', 'Palegate', 'Quarrymill', 'Silverpine', 'Cobalt Ridge', 'Fairmont Hollow', 'Redstone', 'Blue Harbor',
  'Ironwood', 'Copperline', 'Windrose', 'Stonebridge', 'Clearwater', 'Amberfield', 'Granite Peak', 'Lakeview',
  'Summit Point', 'Cedar Crest', 'Harborlight', 'Foxglove', 'Brightpath', 'Meridian Hollow', 'Sandpiper', 'Wildberry',
  'Emberline', 'Thornfield', 'Glasswing', 'Kestrel', 'Marbledale', 'Nightjar', 'Overbrook', 'Pinewater',
  'Quicksilver', 'Rooksbury', 'Saltmarsh', 'Tallgrass', 'Umbermill', 'Vantage Hill', 'Westmere', 'Yarrowfield',
];

const ORGANISATION_SUFFIXES = [
  'Logistics', 'Systems', 'Foods', 'Analytics', 'Industries', 'Partners', 'Holdings', 'Labs',
  'Manufacturing', 'Consulting', 'Technologies', 'Group', 'Supply', 'Robotics', 'Media', 'Ventures',
];

const JOB_TITLES = [
  'Accounts Payable Clerk', 'Account Manager', 'Applications Engineer', 'Assistant Buyer', 'Brand Strategist',
  'Business Analyst', 'Claims Adjuster', 'Communications Officer', 'Compliance Analyst', 'Content Designer',
  'Customer Success Manager', 'Data Analyst', 'Database Administrator', 'Delivery Driver', 'Dental Hygienist',
  'Design Engineer', 'Dispatch Coordinator', 'Electrical Technician', 'Estimator', 'Facilities Manager',
  'Field Service Engineer', 'Financial Controller', 'Fleet Supervisor', 'Graphic Designer', 'Health and Safety Adviser',
  'Human Resources Partner', 'Industrial Designer', 'Insurance Broker', 'Inventory Planner', 'Laboratory Technician',
  'Legal Secretary', 'Logistics Coordinator', 'Maintenance Planner', 'Marketing Executive', 'Mechanical Engineer',
  'Network Administrator', 'Nurse Practitioner', 'Occupational Therapist', 'Office Administrator', 'Operations Manager',
  'Paralegal', 'Payroll Specialist', 'Pharmacy Technician', 'Procurement Officer', 'Product Manager',
  'Production Supervisor', 'Project Coordinator', 'Quality Inspector', 'Quantity Surveyor', 'Recruitment Consultant',
  'Research Assistant', 'Retail Supervisor', 'Sales Representative', 'Service Desk Analyst', 'Site Foreman',
  'Software Engineer', 'Structural Engineer', 'Systems Architect', 'Tax Adviser', 'Technical Writer',
  'Test Engineer', 'Training Officer', 'Transport Planner', 'Underwriter', 'Veterinary Nurse',
  'Warehouse Supervisor', 'Web Developer',
];

/**
 * Real cities with the ZIP prefix each actually owns.
 *
 * Three digits, because that is the level at which a prefix belongs to a place
 * rather than to a single delivery route — generating the last two keeps two
 * personas from the same city apart without either becoming wrong.
 */
const PLACES: readonly Place[] = [
  { locality: 'Albuquerque', region: 'New Mexico', regionCode: 'NM', postalPrefix: '871' },
  { locality: 'Anchorage', region: 'Alaska', regionCode: 'AK', postalPrefix: '995' },
  { locality: 'Atlanta', region: 'Georgia', regionCode: 'GA', postalPrefix: '303' },
  { locality: 'Austin', region: 'Texas', regionCode: 'TX', postalPrefix: '787' },
  { locality: 'Baltimore', region: 'Maryland', regionCode: 'MD', postalPrefix: '212' },
  { locality: 'Baton Rouge', region: 'Louisiana', regionCode: 'LA', postalPrefix: '708' },
  { locality: 'Birmingham', region: 'Alabama', regionCode: 'AL', postalPrefix: '352' },
  { locality: 'Boise', region: 'Idaho', regionCode: 'ID', postalPrefix: '837' },
  { locality: 'Boston', region: 'Massachusetts', regionCode: 'MA', postalPrefix: '021' },
  { locality: 'Buffalo', region: 'New York', regionCode: 'NY', postalPrefix: '142' },
  { locality: 'Charleston', region: 'South Carolina', regionCode: 'SC', postalPrefix: '294' },
  { locality: 'Charlotte', region: 'North Carolina', regionCode: 'NC', postalPrefix: '282' },
  { locality: 'Chicago', region: 'Illinois', regionCode: 'IL', postalPrefix: '606' },
  { locality: 'Cincinnati', region: 'Ohio', regionCode: 'OH', postalPrefix: '452' },
  { locality: 'Cleveland', region: 'Ohio', regionCode: 'OH', postalPrefix: '441' },
  { locality: 'Colorado Springs', region: 'Colorado', regionCode: 'CO', postalPrefix: '809' },
  { locality: 'Columbus', region: 'Ohio', regionCode: 'OH', postalPrefix: '432' },
  { locality: 'Dallas', region: 'Texas', regionCode: 'TX', postalPrefix: '752' },
  { locality: 'Denver', region: 'Colorado', regionCode: 'CO', postalPrefix: '802' },
  { locality: 'Des Moines', region: 'Iowa', regionCode: 'IA', postalPrefix: '503' },
  { locality: 'Detroit', region: 'Michigan', regionCode: 'MI', postalPrefix: '482' },
  { locality: 'El Paso', region: 'Texas', regionCode: 'TX', postalPrefix: '799' },
  { locality: 'Fargo', region: 'North Dakota', regionCode: 'ND', postalPrefix: '581' },
  { locality: 'Fort Worth', region: 'Texas', regionCode: 'TX', postalPrefix: '761' },
  { locality: 'Fresno', region: 'California', regionCode: 'CA', postalPrefix: '937' },
  { locality: 'Grand Rapids', region: 'Michigan', regionCode: 'MI', postalPrefix: '495' },
  { locality: 'Hartford', region: 'Connecticut', regionCode: 'CT', postalPrefix: '061' },
  { locality: 'Honolulu', region: 'Hawaii', regionCode: 'HI', postalPrefix: '968' },
  { locality: 'Houston', region: 'Texas', regionCode: 'TX', postalPrefix: '770' },
  { locality: 'Indianapolis', region: 'Indiana', regionCode: 'IN', postalPrefix: '462' },
  { locality: 'Jackson', region: 'Mississippi', regionCode: 'MS', postalPrefix: '392' },
  { locality: 'Jacksonville', region: 'Florida', regionCode: 'FL', postalPrefix: '322' },
  { locality: 'Kansas City', region: 'Missouri', regionCode: 'MO', postalPrefix: '641' },
  { locality: 'Las Vegas', region: 'Nevada', regionCode: 'NV', postalPrefix: '891' },
  { locality: 'Lexington', region: 'Kentucky', regionCode: 'KY', postalPrefix: '405' },
  { locality: 'Lincoln', region: 'Nebraska', regionCode: 'NE', postalPrefix: '685' },
  { locality: 'Little Rock', region: 'Arkansas', regionCode: 'AR', postalPrefix: '722' },
  { locality: 'Los Angeles', region: 'California', regionCode: 'CA', postalPrefix: '900' },
  { locality: 'Louisville', region: 'Kentucky', regionCode: 'KY', postalPrefix: '402' },
  { locality: 'Madison', region: 'Wisconsin', regionCode: 'WI', postalPrefix: '537' },
  { locality: 'Manchester', region: 'New Hampshire', regionCode: 'NH', postalPrefix: '031' },
  { locality: 'Memphis', region: 'Tennessee', regionCode: 'TN', postalPrefix: '381' },
  { locality: 'Miami', region: 'Florida', regionCode: 'FL', postalPrefix: '331' },
  { locality: 'Milwaukee', region: 'Wisconsin', regionCode: 'WI', postalPrefix: '532' },
  { locality: 'Minneapolis', region: 'Minnesota', regionCode: 'MN', postalPrefix: '554' },
  { locality: 'Nashville', region: 'Tennessee', regionCode: 'TN', postalPrefix: '372' },
  { locality: 'New Orleans', region: 'Louisiana', regionCode: 'LA', postalPrefix: '701' },
  { locality: 'New York', region: 'New York', regionCode: 'NY', postalPrefix: '100' },
  { locality: 'Newark', region: 'New Jersey', regionCode: 'NJ', postalPrefix: '071' },
  { locality: 'Oklahoma City', region: 'Oklahoma', regionCode: 'OK', postalPrefix: '731' },
  { locality: 'Omaha', region: 'Nebraska', regionCode: 'NE', postalPrefix: '681' },
  { locality: 'Orlando', region: 'Florida', regionCode: 'FL', postalPrefix: '328' },
  { locality: 'Philadelphia', region: 'Pennsylvania', regionCode: 'PA', postalPrefix: '191' },
  { locality: 'Phoenix', region: 'Arizona', regionCode: 'AZ', postalPrefix: '850' },
  { locality: 'Pittsburgh', region: 'Pennsylvania', regionCode: 'PA', postalPrefix: '152' },
  { locality: 'Portland', region: 'Maine', regionCode: 'ME', postalPrefix: '041' },
  { locality: 'Portland', region: 'Oregon', regionCode: 'OR', postalPrefix: '972' },
  { locality: 'Providence', region: 'Rhode Island', regionCode: 'RI', postalPrefix: '029' },
  { locality: 'Raleigh', region: 'North Carolina', regionCode: 'NC', postalPrefix: '276' },
  { locality: 'Richmond', region: 'Virginia', regionCode: 'VA', postalPrefix: '232' },
  { locality: 'Sacramento', region: 'California', regionCode: 'CA', postalPrefix: '958' },
  { locality: 'Salt Lake City', region: 'Utah', regionCode: 'UT', postalPrefix: '841' },
  { locality: 'San Antonio', region: 'Texas', regionCode: 'TX', postalPrefix: '782' },
  { locality: 'San Diego', region: 'California', regionCode: 'CA', postalPrefix: '921' },
  { locality: 'San Francisco', region: 'California', regionCode: 'CA', postalPrefix: '941' },
  { locality: 'Savannah', region: 'Georgia', regionCode: 'GA', postalPrefix: '314' },
  { locality: 'Seattle', region: 'Washington', regionCode: 'WA', postalPrefix: '981' },
  { locality: 'Sioux Falls', region: 'South Dakota', regionCode: 'SD', postalPrefix: '571' },
  { locality: 'Spokane', region: 'Washington', regionCode: 'WA', postalPrefix: '992' },
  { locality: 'St. Louis', region: 'Missouri', regionCode: 'MO', postalPrefix: '631' },
  { locality: 'Tampa', region: 'Florida', regionCode: 'FL', postalPrefix: '336' },
  { locality: 'Tucson', region: 'Arizona', regionCode: 'AZ', postalPrefix: '857' },
  { locality: 'Tulsa', region: 'Oklahoma', regionCode: 'OK', postalPrefix: '741' },
  { locality: 'Wichita', region: 'Kansas', regionCode: 'KS', postalPrefix: '672' },
  { locality: 'Wilmington', region: 'Delaware', regionCode: 'DE', postalPrefix: '198' },
];

export const EN_US: Corpus = {
  locale: 'en-US',
  country: 'United States',
  countryCode: 'US',

  firstNames: FIRST_NAMES,
  lastNames: LAST_NAMES,
  streetStems: STREET_STEMS,
  streetSuffixes: STREET_SUFFIXES,
  organisationStems: ORGANISATION_STEMS,
  organisationSuffixes: ORGANISATION_SUFFIXES,
  jobTitles: JOB_TITLES,
  places: PLACES,

  streetLine: (street, number) => `${String(number)} ${street}`,
  postalCode: (place, random) => `${place.postalPrefix}${digits(2, random)}`,

  // 555-0100 through 555-0199 is reserved for fiction across the North American
  // Numbering Plan. Realism yields to not ringing a stranger: a tester filling a
  // form on a live system may well cause it to dial.
  phone: (random) => `+1 ${String(between(201, 989, random))}-555-01${String(between(0, 99, random)).padStart(2, '0')}`,

  // Deliberately absent. A Social Security number carries no checksum, so a
  // generated one is indistinguishable from a real one — the argument that makes
  // a Swiss AHV number safe to emit does not hold here.
  nationalId: undefined,
  iban: undefined,
};
