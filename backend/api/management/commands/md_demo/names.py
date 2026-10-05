"""Indian names, places, banks and companies for the demo company. Everything here is fictional: a person's name is a
random pairing of common first names and surnames, a company name is invented, phone numbers and bank accounts are
random digits, e-mail addresses end in ``.example`` (a reserved domain that can never be delivered)."""

from __future__ import annotations

import random
import re
from dataclasses import dataclass

# Tirupur's workforce is mostly Tamil with a large share of migrant workers from Odisha, Bihar, Jharkhand, Bengal and Assam.
REGION_WEIGHTS = {"tamil": 72, "kerala": 3, "telugu": 4, "kannada": 2, "odisha": 7, "hindi_belt": 7, "east": 5}

FIRST_NAMES: dict[str, dict[str, list[str]]] = {
    "tamil": {
        "male": [
            "Murugan",
            "Selvam",
            "Senthil",
            "Saravanan",
            "Karthik",
            "Arun",
            "Vignesh",
            "Prakash",
            "Ganesh",
            "Ramesh",
            "Suresh",
            "Mani",
            "Raja",
            "Siva",
            "Balaji",
            "Dinesh",
            "Manoj",
            "Naveen",
            "Vijay",
            "Ajith",
            "Gokul",
            "Harish",
            "Lokesh",
            "Pandian",
            "Palani",
            "Velu",
            "Muthu",
            "Bala",
            "Anbu",
            "Elango",
            "Gopal",
            "Jegan",
            "Kathir",
            "Mohan",
            "Nagaraj",
            "Paramasivam",
            "Rajendran",
            "Sakthivel",
            "Thangaraj",
            "Udhaya",
            "Venkatesh",
            "Yuvaraj",
            "Chandran",
            "Dhanapal",
            "Ezhil",
            "Ilango",
            "Kannan",
            "Loganathan",
            "Manikandan",
            "Natarajan",
            "Periyasamy",
            "Rajkumar",
            "Sathish",
            "Tamilarasan",
            "Vetri",
            "Vinoth",
            "Dhanush",
            "Kamalakannan",
            "Sivakumar",
            "Thirumalai",
            "Ravichandran",
            "Sundar",
            "Karuppasamy",
            "Marimuthu",
            "Ponnusamy",
            "Annadurai",
        ],
        "female": [
            "Lakshmi",
            "Kavitha",
            "Selvi",
            "Meena",
            "Priya",
            "Divya",
            "Saranya",
            "Revathi",
            "Malathi",
            "Geetha",
            "Sumathi",
            "Pushpa",
            "Kamala",
            "Nirmala",
            "Chitra",
            "Prema",
            "Valli",
            "Usha",
            "Jothi",
            "Amutha",
            "Anitha",
            "Bharathi",
            "Deepa",
            "Eswari",
            "Gomathi",
            "Indhu",
            "Janaki",
            "Kalaivani",
            "Latha",
            "Mythili",
            "Nandhini",
            "Padma",
            "Rajeswari",
            "Sathya",
            "Thenmozhi",
            "Uma",
            "Vasanthi",
            "Yamuna",
            "Abirami",
            "Bhuvana",
            "Dhanalakshmi",
            "Gayathri",
            "Hema",
            "Kokila",
            "Mahalakshmi",
            "Pavithra",
            "Ramya",
            "Sangeetha",
            "Tamilselvi",
            "Vidhya",
            "Maheswari",
            "Sudha",
            "Poongodi",
            "Rani",
            "Muthulakshmi",
            "Parvathi",
            "Sasikala",
            "Jayanthi",
            "Vimala",
            "Kanimozhi",
            "Santhi",
            "Radha",
        ],
    },
    "kerala": {
        "male": ["Anil", "Suresh", "Jayan", "Rajan", "Biju", "Sajan", "Manoj", "Shibu", "Sreejith", "Vinod"],
        "female": ["Bindu", "Sheela", "Lissy", "Remya", "Sandhya", "Sini", "Anju", "Resmi", "Jincy", "Deepthi"],
    },
    "telugu": {
        "male": ["Venkat", "Srinivas", "Ravi", "Naresh", "Ramana", "Satish", "Narasimha", "Prasad", "Hari", "Mahesh"],
        "female": [
            "Lakshmi",
            "Sirisha",
            "Padmaja",
            "Swathi",
            "Anuradha",
            "Vijaya",
            "Sunitha",
            "Madhavi",
            "Rajitha",
            "Sravani",
        ],
    },
    "kannada": {
        "male": ["Basavaraj", "Manjunath", "Shivakumar", "Raghu", "Nagesh", "Mahadev", "Prakash", "Girish"],
        "female": ["Savitha", "Nagamma", "Shobha", "Kalpana", "Rekha", "Vanitha", "Roopa", "Girija"],
    },
    "odisha": {
        "male": [
            "Bikash",
            "Dilip",
            "Gopal",
            "Rajesh",
            "Santosh",
            "Pradeep",
            "Sanjay",
            "Prakash",
            "Sudhir",
            "Ashok",
            "Debendra",
            "Jagannath",
            "Kishore",
            "Laxman",
            "Narayan",
            "Pabitra",
            "Rabindra",
            "Sarat",
            "Trilochan",
        ],
        "female": [
            "Sabita",
            "Anita",
            "Sunita",
            "Kiran",
            "Rasmita",
            "Pushpanjali",
            "Manjulata",
            "Namita",
            "Basanti",
            "Jyotsna",
            "Laxmipriya",
            "Mamata",
            "Rashmi",
            "Sarmistha",
            "Tulasi",
        ],
    },
    "hindi_belt": {
        "male": [
            "Sunil",
            "Anil",
            "Rakesh",
            "Manoj",
            "Sanjay",
            "Ravi",
            "Deepak",
            "Vikas",
            "Amit",
            "Rahul",
            "Mukesh",
            "Dharmendra",
            "Ramesh",
            "Pankaj",
            "Umesh",
            "Brijesh",
            "Naresh",
            "Raju",
        ],
        "female": [
            "Sunita",
            "Rekha",
            "Anita",
            "Poonam",
            "Geeta",
            "Seema",
            "Kiran",
            "Meena",
            "Savita",
            "Rani",
            "Babita",
        ],
    },
    "east": {
        "male": ["Dipak", "Subhash", "Biswajit", "Tapan", "Sukanta", "Ranjit", "Pranab", "Hemanta", "Jiten", "Bhaskar"],
        "female": ["Mitali", "Rupa", "Sima", "Anjali", "Moushumi", "Purnima", "Jharna", "Nilima", "Kabita", "Dolly"],
    },
}

SURNAMES: dict[str, list[str]] = {
    "tamil": [
        "Kumar",
        "Raj",
        "Pillai",
        "Gounder",
        "Chettiar",
        "Pandian",
        "Subramaniam",
        "Krishnan",
        "Murthy",
        "Iyer",
        "Naidu",
        "Devar",
        "Nadar",
        "Selvam",
        "Rajan",
        "Velu",
        "Mani",
        "Natarajan",
        "Palanisamy",
        "Shanmugam",
    ],
    "kerala": ["Nair", "Pillai", "Menon", "Varghese", "Thomas", "Kurian", "Das", "Mathew"],
    "telugu": ["Reddy", "Naidu", "Rao", "Chowdary", "Raju", "Goud", "Babu"],
    "kannada": ["Gowda", "Shetty", "Naik", "Patil", "Hegde", "Rao"],
    "odisha": ["Behera", "Nayak", "Sahu", "Pradhan", "Mahanta", "Swain", "Mohanty", "Das", "Jena", "Panda", "Muduli"],
    "hindi_belt": [
        "Kumar",
        "Yadav",
        "Singh",
        "Prasad",
        "Mahato",
        "Munda",
        "Mandal",
        "Sharma",
        "Verma",
        "Kumari",
        "Ansari",
    ],
    "east": ["Das", "Mondal", "Barman", "Roy", "Ghosh", "Saha", "Bora", "Borah", "Hazarika", "Sarkar"],
}
INITIALS = "KSMRPAVTNGBCDEJL"

AREAS = [
    "Gandhi Nagar",
    "Kongu Nagar",
    "Pushpa Nagar",
    "Veerapandi",
    "Andipalayam",
    "Rayapuram",
    "Anupparpalayam",
    "Periyar Colony",
    "Nallur",
    "Kasipalayam",
    "Mannarai",
    "Perumanallur",
    "Chinnakkarai",
    "Thirumuruganpoondi",
    "Palladam Road",
    "Avinashi Road",
    "Kumaran Road",
    "Mangalam Road",
    "Dharapuram Road",
    "Kangeyam Road",
    "Neruperichal",
    "Murugampalayam",
    "Iduvampalayam",
    "Valipalayam",
    "Karaipudur",
    "Pooluvapatti",
]
CITIES = [
    "Tirupur",
    "Coimbatore",
    "Erode",
    "Salem",
    "Dindigul",
    "Karur",
    "Namakkal",
    "Pollachi",
    "Udumalpet",
    "Avinashi",
]

BANKS = [
    ("State Bank of India", "SBIN"),
    ("Indian Bank", "IDIB"),
    ("Canara Bank", "CNRB"),
    ("Indian Overseas Bank", "IOBA"),
    ("HDFC Bank", "HDFC"),
    ("Karur Vysya Bank", "KVBL"),
    ("Tamilnad Mercantile Bank", "TMBL"),
    ("City Union Bank", "CIUB"),
]
BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "O+", "O-", "O+", "B+", "A+"]

# Companies that visit the factory: invented, with a business that explains why they come.
SUPPLIERS = [
    ("Annai Trims & Labels", "trims and labels"),
    ("Vetrivel Packaging Industries", "cartons and poly bags"),
    ("Sakthi Thread Mills", "sewing thread"),
    ("Pearl Fabric Traders", "knitted fabric"),
    ("Tirupur Dyes & Chemicals", "dyes and chemicals"),
    ("Kongu Elastics", "elastic and tapes"),
    ("Sri Ganesh Buttons", "buttons and zips"),
    ("Lotus Hangers & Accessories", "hangers and stickers"),
    ("Murugan Machine Spares", "sewing machine spares"),
    ("Coastal Yarn Agency", "cotton yarn"),
    ("Everbright Needles", "needles and bobbins"),
    ("Cauvery Boilers & Steam", "boiler spares"),
]
BUYERS = [
    ("Nordic Retail Sourcing", "buying house"),
    ("Atlas Apparel Group", "buyer's merchandiser"),
    ("Blue Lotus Exports", "export agent"),
    ("Meridian Brands", "buyer's QA team"),
    ("Orion Buying House", "buying house"),
]
AUDITORS = [
    ("Global Compliance Audits", "social compliance audit"),
    ("SafeWorks Certification", "fire and safety inspection"),
    ("Bureau of Textile Standards", "quality system audit"),
    ("GreenLeaf Sustainability", "environmental audit"),
]
SERVICE_COMPANIES = [
    ("Precision Machine Services", "machine servicing"),
    ("CoolAir Systems", "air-conditioning service"),
    ("SecureVision CCTV", "CCTV maintenance"),
    ("NetBridge IT Services", "network and computer support"),
    ("PowerGrid Electricals", "electrical contractor"),
]
TRANSPORTERS = [
    ("Sri Vinayaga Transport", "goods transport"),
    ("Kovai Express Cargo", "courier"),
    ("Southern Lines Logistics", "freight"),
    ("Speedwell Couriers", "courier"),
]
OFFICIALS = [
    ("Factory Inspectorate", "routine inspection"),
    ("Provident Fund Office", "PF compliance visit"),
    ("ESI Corporation", "ESI inspection"),
    ("Pollution Control Board", "effluent inspection"),
]

RESIGNATION_REASONS = [
    ("Better opportunity elsewhere", 28),
    ("Relocating to native place", 18),
    ("Personal / family reasons", 18),
    ("Salary and wages", 10),
    ("Health reasons", 8),
    ("Higher studies", 6),
    ("Marriage", 6),
    ("Commute / transport difficulty", 6),
]


@dataclass(frozen=True)
class PersonName:
    first: str
    last: str
    gender: str
    region: str

    @property
    def full(self) -> str:
        return f"{self.first} {self.last}".strip()


class NameFactory:
    """Hands out unique names (no two employees read alike), phones, e-mails and addresses from one random stream."""

    def __init__(self, rng: random.Random) -> None:
        self.rng = rng
        self._names: set[str] = set()
        self._phones: set[str] = set()
        self._regions = list(REGION_WEIGHTS)
        self._region_weights = list(REGION_WEIGHTS.values())

    def person(self, gender: str | None = None, region: str | None = None) -> PersonName:
        rng = self.rng
        gender = gender or ("male" if rng.random() < 0.55 else "female")
        region = region or rng.choices(self._regions, weights=self._region_weights, k=1)[0]
        for attempt in range(40):
            first = rng.choice(FIRST_NAMES[region][gender])
            # Tamil names usually carry a father's initial rather than a surname ("Murugan K").
            if region == "tamil" and rng.random() < 0.55:
                last = rng.choice(INITIALS)
            else:
                last = rng.choice(SURNAMES[region])
            key = f"{first} {last}".lower()
            if key not in self._names or attempt == 39:
                if key in self._names:  # the pool is exhausted for this pair: make it distinct with a second initial
                    last = f"{last} {rng.choice(INITIALS)}"
                    key = f"{first} {last}".lower()
                self._names.add(key)
                return PersonName(first, last, gender, region)
        raise AssertionError("unreachable")

    def phone(self) -> str:
        while True:
            number = "9" + "".join(str(self.rng.randint(0, 9)) for _ in range(9))
            if number not in self._phones:
                self._phones.add(number)
                return number

    def email(self, name: PersonName, domain: str = "uktextiles.example") -> str:
        slug = re.sub(r"[^a-z0-9]+", ".", f"{name.first}.{name.last}".lower()).strip(".")
        return f"{slug}@{domain}"

    def address(self) -> str:
        rng = self.rng
        return f"{rng.randint(1, 240)}, {rng.choice(AREAS)}, Tirupur - 6416{rng.randint(0, 9)}{rng.randint(0, 9)}"

    def father(self, name: PersonName) -> str:
        """A plausible father's name: a male first name of the same region, carrying the same surname or initial."""
        rng = self.rng
        return f"{rng.choice(FIRST_NAMES[name.region]['male'])} {name.last}"

    def bank(self) -> tuple[str, str, str]:
        rng = self.rng
        bank, prefix = rng.choice(BANKS)
        account = "".join(str(rng.randint(0, 9)) for _ in range(rng.choice([11, 12, 14])))
        return bank, account, f"{prefix}0{''.join(str(rng.randint(0, 9)) for _ in range(6))}"
