/** T-2731: the Policy create form validates as the server does (see formValidation.tsx). */
import { formValidationSuite } from "./formValidation";

formValidationSuite({ kind: "Policy", address: "/projects/helsinki/policies/new" });
